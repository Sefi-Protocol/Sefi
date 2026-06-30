import type {
  Network,
  ProtocolContext,
  SefiAnswer,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import type { StellarClient } from "@sefi/stellar-client";
import type { SefiStore } from "@sefi/store";
import { buildSourceRecord, computeAdapterHash } from "@sefi/source-records";
import {
  assembleAnswer,
  buildFact,
  checkFreshness,
  factValue,
  spreadBps,
} from "@sefi/semantic-core";
import { buildAndSaveCapsule } from "@sefi/context-capsules";
import { assetParams } from "./asset.js";

const ADAPTER_NAME = "sdex";
const ADAPTER_VERSION = "1.0.0";
const ADAPTER_HASH = computeAdapterHash(ADAPTER_NAME, ADAPTER_VERSION, "sdex-live-v1");
const WIDE_SPREAD_BPS = 50; // 0.5%

export interface AdapterContext {
  network: Network;
  client: StellarClient;
  store?: SefiStore;
}

export interface GetMarketRequest {
  base: string;
  counter: string;
}
export interface FindPathRequest {
  sourceAsset: string;
  destinationAsset: string;
  sourceAmount: string;
}

/**
 * Stellar DEX / Classic AMM adapter (spec §10) — LIVE only. Reads real Horizon
 * order books, strict-send paths and classic liquidity pools, computing spread
 * + fallback-liquidity semantics. No fixtures: real ledger data or error.
 */
export class SdexAdapter {
  constructor(private ctx: AdapterContext) {}

  private record(
    kind: SourceRecord["sourceKind"],
    endpoint: string,
    response: unknown,
    ledger?: number,
  ): SourceRecord {
    return buildSourceRecord({
      network: this.ctx.network,
      protocol: "stellar_dex",
      sourceKind: kind,
      endpoint,
      response,
      ledgerSeq: ledger,
      latestLedger: ledger,
      adapterName: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: ADAPTER_HASH,
    });
  }

  async getMarket(req: GetMarketRequest): Promise<ProtocolContext> {
    const base = await this.ctx.client.horizonAsset(req.base);
    const counter = await this.ctx.client.horizonAsset(req.counter);
    const r = await this.ctx.client.horizonGet("order_book", {
      ...assetParams("selling", base),
      ...assetParams("buying", counter),
      limit: 10,
    });
    const body = r.body as any;
    const bids = (body?.bids ?? []) as Array<{ price: string; amount: string }>;
    const asks = (body?.asks ?? []) as Array<{ price: string; amount: string }>;
    const bestBid = bids[0]?.price ? Number(bids[0].price) : undefined;
    const bestAsk = asks[0]?.price ? Number(asks[0].price) : undefined;
    const sources = [this.record("horizon_orderbook", r.endpoint, body, r.ledger)];

    const spread =
      bestBid !== undefined && bestAsk !== undefined
        ? Math.round(spreadBps(bestBid, bestAsk))
        : undefined;
    const mid =
      bestBid !== undefined && bestAsk !== undefined
        ? (bestBid + bestAsk) / 2
        : undefined;
    const entityId = `market:${base.label}:${counter.label}`;
    const facts: SemanticFact[] = [];
    const add = (field: string, value: unknown, unit?: string) =>
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "stellar_dex",
          entityType: "market",
          entityId,
          field,
          value,
          unit,
          ledgerSeq: r.ledger,
          sources,
          confidence: "medium",
        }),
      );
    if (bestBid !== undefined) add("market.best_bid", bestBid);
    if (bestAsk !== undefined) add("market.best_ask", bestAsk);
    if (spread !== undefined) add("market.spread_bps", spread, "bps");

    // Depth bands: cumulative ask-side base volume available within 1% / 2% of mid.
    if (mid !== undefined) {
      add("liquidity.depth_1pct", depthWithin(asks, mid, 0.01).toFixed(7), "base");
      add("liquidity.depth_2pct", depthWithin(asks, mid, 0.02).toFixed(7), "base");
    }

    // Recent volume from /trades (last 100).
    let recentVolume: string | undefined;
    let recentTrades = 0;
    try {
      const t = await this.ctx.client.horizonGet("trades", {
        ...assetParams("base", base),
        ...assetParams("counter", counter),
        order: "desc",
        limit: 100,
      });
      const records = ((t.body as any)?._embedded?.records ?? []) as any[];
      recentTrades = records.length;
      const vol = records.reduce((a, x) => a + Number(x.base_amount ?? 0), 0);
      recentVolume = vol.toFixed(7);
      sources.push(this.record("horizon_trades", t.endpoint, t.body, t.ledger));
      add("market.recent_volume", recentVolume, "base");
      add("market.recent_trades", recentTrades, "count");
    } catch {
      /* trades optional */
    }

    await this.persist(facts, sources);
    return {
      protocol: "stellar_dex",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings:
        bestBid === undefined || bestAsk === undefined
          ? ["Order book is one-sided or empty for this market."]
          : [],
    };
  }

  /** Active offers count for a market (spec §10.2 /offers). */
  async getOffers(req: GetMarketRequest): Promise<ProtocolContext> {
    const selling = await this.ctx.client.horizonAsset(req.base);
    const buying = await this.ctx.client.horizonAsset(req.counter);
    const r = await this.ctx.client.horizonGet("offers", {
      ...assetParams("selling", selling),
      ...assetParams("buying", buying),
      limit: 50,
    });
    const records = ((r.body as any)?._embedded?.records ?? []) as any[];
    const sources = [this.record("horizon_offers", r.endpoint, r.body, r.ledger)];
    const facts = [
      buildFact({
        network: this.ctx.network,
        protocol: "stellar_dex",
        entityType: "market",
        entityId: `market:${selling.label}:${buying.label}`,
        field: "market.open_offers",
        value: records.length,
        unit: "count",
        ledgerSeq: r.ledger,
        sources,
        confidence: "medium",
      }),
    ];
    await this.persist(facts, sources);
    return {
      protocol: "stellar_dex",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings: [],
    };
  }

  async findPath(req: FindPathRequest): Promise<ProtocolContext> {
    const source = await this.ctx.client.horizonAsset(req.sourceAsset);
    const dest = await this.ctx.client.horizonAsset(req.destinationAsset);
    // Horizon strict-send takes the source asset + a decimal amount (units, not
    // stroops) and the destination set via `destination_assets` (canonical form).
    const r = await this.ctx.client.horizonGet("paths/strict-send", {
      ...assetParams("source", source),
      source_amount: stroopsToUnits(req.sourceAmount),
      destination_assets: canonicalAsset(dest),
    });
    const records = (r.body as any)?._embedded?.records ?? [];
    const best = records[0];
    const pathAvailable = Boolean(best);
    const estimatedOut = best?.destination_amount as string | undefined;
    const pathAssets: string[] = (best?.path ?? []).map((a: any) =>
      a.asset_type === "native" ? "XLM" : a.asset_code,
    );
    const sources = [this.record("horizon_paths", r.endpoint, r.body, r.ledger)];

    const entityId = `path:${source.label}:${dest.label}:${req.sourceAmount}`;
    const facts: SemanticFact[] = [
      buildFact({
        network: this.ctx.network,
        protocol: "stellar_dex",
        entityType: "route",
        entityId,
        field: "path.available",
        value: pathAvailable,
        unit: "bool",
        ledgerSeq: r.ledger,
        sources,
        confidence: "medium",
      }),
    ];
    if (estimatedOut !== undefined)
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "stellar_dex",
          entityType: "route",
          entityId,
          field: "path.estimated_out",
          value: estimatedOut,
          unit: "units",
          ledgerSeq: r.ledger,
          sources,
          confidence: "medium",
        }),
        buildFact({
          network: this.ctx.network,
          protocol: "stellar_dex",
          entityType: "route",
          entityId,
          field: "route.hops",
          value: pathAssets.length + 1,
          unit: "count",
          ledgerSeq: r.ledger,
          sources,
          confidence: "medium",
        }),
      );

    await this.persist(facts, sources);
    return {
      protocol: "stellar_dex",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings: pathAvailable ? [] : ["No strict-send path found on Horizon."],
    };
  }

  /**
   * Strict-receive path (spec §10.2): given a desired destination amount, find
   * the cheapest source amount on Horizon.
   */
  async findPathStrictReceive(req: {
    sourceAsset: string;
    destinationAsset: string;
    destinationAmount: string;
  }): Promise<ProtocolContext> {
    const source = await this.ctx.client.horizonAsset(req.sourceAsset);
    const dest = await this.ctx.client.horizonAsset(req.destinationAsset);
    const r = await this.ctx.client.horizonGet("paths/strict-receive", {
      ...assetParams("destination", dest),
      destination_amount: stroopsToUnits(req.destinationAmount),
      source_assets: canonicalAsset(source),
    });
    const records = (r.body as any)?._embedded?.records ?? [];
    const best = records[0];
    const available = Boolean(best);
    const sourceAmount = best?.source_amount as string | undefined;
    const sources = [this.record("horizon_paths", r.endpoint, r.body, r.ledger)];
    const entityId = `path_recv:${source.label}:${dest.label}:${req.destinationAmount}`;
    const facts: SemanticFact[] = [
      buildFact({
        network: this.ctx.network,
        protocol: "stellar_dex",
        entityType: "route",
        entityId,
        field: "path.available",
        value: available,
        unit: "bool",
        ledgerSeq: r.ledger,
        sources,
        confidence: "medium",
      }),
    ];
    if (sourceAmount !== undefined)
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "stellar_dex",
          entityType: "route",
          entityId,
          field: "path.source_amount",
          value: sourceAmount,
          unit: "units",
          ledgerSeq: r.ledger,
          sources,
          confidence: "medium",
        }),
      );
    await this.persist(facts, sources);
    return {
      protocol: "stellar_dex",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings: available ? [] : ["No strict-receive path found on Horizon."],
    };
  }

  async getLiquidityPools(req: GetMarketRequest): Promise<ProtocolContext> {
    const base = await this.ctx.client.horizonAsset(req.base);
    const counter = await this.ctx.client.horizonAsset(req.counter);
    const r = await this.ctx.client.horizonGet("liquidity_pools", {
      reserves: `${assetReserve(base)},${assetReserve(counter)}`,
      limit: 5,
    });
    const body = r.body as any;
    const records = (body?._embedded?.records ?? []) as any[];
    const sources = [this.record("horizon_liquidity_pools", r.endpoint, body, r.ledger)];
    const entityId = `classic_lp:${base.label}:${counter.label}`;
    const facts: SemanticFact[] = [
      buildFact({
        network: this.ctx.network,
        protocol: "stellar_amm",
        entityType: "pool",
        entityId,
        field: "liquidity.available",
        value: records.length,
        unit: "count",
        ledgerSeq: r.ledger,
        sources,
        confidence: "medium",
      }),
    ];
    const top = records[0];
    if (top) {
      const ledger = top.last_modified_ledger ?? r.ledger;
      const poolEntity = `classic_lp:${top.id}`;
      const add = (field: string, value: unknown, unit?: string) =>
        facts.push(
          buildFact({
            network: this.ctx.network,
            protocol: "stellar_amm",
            entityType: "pool",
            entityId: poolEntity,
            field,
            value,
            unit,
            ledgerSeq: ledger,
            sources,
            confidence: "medium",
          }),
        );
      add("pool.id", top.id);
      add("pool.total_shares", top.total_shares, "shares");
      add("pool.fee_bps", top.fee_bp, "bps");
      add("pool.trustlines", top.total_trustlines, "count");
      for (const res of top.reserves ?? []) {
        const sym = res.asset === "native" ? "XLM" : res.asset.split(":")[0];
        add(`pool.reserve.${sym}`, res.amount, "units");
      }
    }
    await this.persist(facts, sources);
    return {
      protocol: "stellar_amm",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings: records.length ? [] : ["No classic liquidity pool for this pair."],
    };
  }

  async createContext(req: {
    market?: GetMarketRequest;
    path?: FindPathRequest;
    liquidityPools?: GetMarketRequest;
  }): Promise<ProtocolContext> {
    if (req.path) return this.findPath(req.path);
    if (req.market) return this.getMarket(req.market);
    if (req.liquidityPools) return this.getLiquidityPools(req.liquidityPools);
    throw new Error("sdex.createContext requires market, path or liquidityPools");
  }

  async ask(
    question: string,
    params: { sourceAsset: string; destinationAsset: string; amount: string },
  ): Promise<SefiAnswer> {
    const path = await this.findPath({
      sourceAsset: params.sourceAsset,
      destinationAsset: params.destinationAsset,
      sourceAmount: params.amount,
    });
    const market = await this.getMarket({
      base: params.destinationAsset,
      counter: params.sourceAsset,
    });
    const facts = [...path.facts, ...market.facts];
    const sources = [...path.sourceRecords, ...market.sourceRecords];
    const capsule = await buildAndSaveCapsule(
      {
        network: this.ctx.network,
        protocols: ["stellar_dex"],
        facts,
        sourceRecords: sources,
      },
      this.ctx.store,
    );
    const fresh = checkFreshness(facts);

    const available = Boolean(factValue(path.facts, "path.available"));
    const out = String(factValue(path.facts, "path.estimated_out") ?? "0");
    const spread = Number(factValue(market.facts, "market.spread_bps") ?? NaN);
    const wide = Number.isFinite(spread) && spread > WIDE_SPREAD_BPS;
    const decision: SefiAnswer["decision"] = available
      ? wide
        ? "conditional"
        : "safe"
      : "unsafe";

    const text = available
      ? `A Stellar DEX exit path exists for ${params.sourceAsset}->${params.destinationAsset} with estimated output ${out} ${params.destinationAsset}. ` +
        (Number.isFinite(spread)
          ? `The market spread is ${spread} bps${wide ? ", which is wider than ideal — acceptable only with higher slippage tolerance." : ", tight enough for this size."}`
          : "Spread data is unavailable.")
      : `No Stellar DEX path is currently available for ${params.sourceAsset}->${params.destinationAsset}.`;

    return assembleAnswer({
      text,
      decision,
      recommendedActions: available
        ? wide
          ? ["Prefer an AMM route if spread matters; use SDEX only as fallback"]
          : ["SDEX is a viable exit at this size"]
        : ["Seek liquidity on an AMM route instead"],
      facts,
      sourceRecords: sources,
      contextCapsuleId: capsule.id,
      warnings: [
        ...path.warnings,
        ...market.warnings,
        ...fresh.warnings,
        "This is source-backed but not yet ZK-proven.",
      ],
    });
  }

  private async persist(facts: SemanticFact[], sources: SourceRecord[]) {
    if (!this.ctx.store) return;
    await this.ctx.store.saveSourceRecords(sources);
    await this.ctx.store.saveFacts(facts);
  }
}

type ResolvedAsset = { type: string; code?: string; issuer?: string };

function assetReserve(asset: ResolvedAsset): string {
  if (asset.type === "native") return "native";
  return `${asset.code}:${asset.issuer}`;
}

/** Canonical asset string for Horizon path `*_assets` params. */
function canonicalAsset(asset: ResolvedAsset): string {
  return asset.type === "native" ? "native" : `${asset.code}:${asset.issuer}`;
}

/**
 * Cumulative base-asset volume on one side of the book reachable within `pct`
 * of mid price (depth band). For asks (price ascending), sum `amount` while
 * `price <= mid*(1+pct)`.
 */
function depthWithin(
  levels: Array<{ price: string; amount: string }>,
  mid: number,
  pct: number,
): number {
  const limit = mid * (1 + pct);
  let total = 0;
  for (const lvl of levels) {
    if (Number(lvl.price) > limit) break;
    total += Number(lvl.amount);
  }
  return total;
}

/** Stellar amounts are fixed-point with 7 decimals; convert stroops -> units. */
function stroopsToUnits(stroops: string): string {
  const s = BigInt(stroops);
  const whole = s / 10_000_000n;
  const frac = (s % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}
