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
  routeHopsOk,
  slippageBps,
  slippageOk,
} from "@sefi/semantic-core";
import { buildAndSaveCapsule } from "@sefi/context-capsules";

const ADAPTER_NAME = "aquarius";
const ADAPTER_VERSION = "1.0.0";
const ADAPTER_HASH = computeAdapterHash(ADAPTER_NAME, ADAPTER_VERSION, "aquarius-live-v1");
const MAX_SLIPPAGE_BPS = 100; // 1% default policy (spec §9.5)

/** Aquarius AMM mainnet router/aggregator contract (docs.aqua.network). */
const ROUTER_MAINNET = "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK";

export interface AdapterContext {
  network: Network;
  client: StellarClient;
  store?: SefiStore;
  routerContractId?: string;
}

export interface GetPoolsRequest {
  tokenA: string;
  tokenB: string;
}
export interface EstimateSwapRequest {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  maxSlippageBps?: number;
}

function extractContractIds(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (/^C[A-Z0-9]{55}$/.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v instanceof Map) {
      for (const x of v.values()) visit(x);
    } else if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return [...new Set(out)];
}

/**
 * Aquarius AMM adapter (spec §9) — LIVE only. Discovers pools via the router's
 * `get_pools(tokens)` and prices swaps via the pool's `estimate_swap(in_idx,
 * out_idx, amount)` (docs.aqua.network), all over Soroban simulateTransaction.
 * Slippage is derived from a small-amount reference estimate (real spot price).
 */
export class AquariusAdapter {
  constructor(private ctx: AdapterContext) {}

  private router(): string {
    if (this.ctx.routerContractId) return this.ctx.routerContractId;
    if (process.env.AQUARIUS_ROUTER) return process.env.AQUARIUS_ROUTER;
    if (this.ctx.network === "mainnet") return ROUTER_MAINNET;
    throw new Error("Aquarius router contract id required (set AQUARIUS_ROUTER for testnet)");
  }

  private record(
    fn: string,
    contractId: string,
    value: unknown,
    rawXdr?: string,
    ledger?: number,
  ): SourceRecord {
    return buildSourceRecord({
      network: this.ctx.network,
      protocol: "aquarius",
      sourceKind: "stellar_rpc_simulate",
      contractId,
      functionName: fn,
      response: value,
      rawXdr,
      ledgerSeq: ledger,
      latestLedger: ledger,
      adapterName: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: ADAPTER_HASH,
    });
  }

  /** Resolve token pair -> sorted contract ids + the pools for that pair. */
  private async discoverPools(
    tokenA: string,
    tokenB: string,
  ): Promise<{ sorted: string[]; pools: string[]; source: SourceRecord }> {
    const client = this.ctx.client;
    const cidA = await client.assetContractId(tokenA);
    const cidB = await client.assetContractId(tokenB);
    const sorted = await client.sortTokenIds([cidA, cidB]);
    const addrVec = await client.vec([
      await client.addressScVal(sorted[0]),
      await client.addressScVal(sorted[1]),
    ]);
    const res = await client.simulate(this.router(), "get_pools", [addrVec]);
    const pools = extractContractIds(res.value);
    const source = this.record(
      "get_pools",
      this.router(),
      { tokens: sorted, pools },
      res.resultXdr,
      res.latestLedger,
    );
    return { sorted, pools, source };
  }

  /**
   * Read a pool's info/reserves/shares (spec §9: pool.get_info). pool_type maps
   * to constant_product / stable_swap / concentrated; stable pools are "stable",
   * everything else "volatile". TVL is the sum of reserves (proxy).
   */
  private async fetchPoolInfo(poolId: string): Promise<{
    facts: PoolInfo;
    sources: SourceRecord[];
  }> {
    const client = this.ctx.client;
    const sources: SourceRecord[] = [];
    const info: PoolInfo = { poolId };
    try {
      const r = await client.simulate(poolId, "get_info", []);
      sources.push(this.record("get_info", poolId, normalizeBigInts(r.value), r.resultXdr, r.latestLedger));
      const m = r.value as any;
      info.poolType = mapPoolType(m?.pool_type);
      info.feeBps = m?.fee != null ? Number(m.fee) : undefined;
      info.tickSpacing = m?.tick_spacing != null ? Number(m.tick_spacing) : undefined;
    } catch {
      /* pool getter not present */
    }
    try {
      const r = await client.simulate(poolId, "get_reserves", []);
      sources.push(this.record("get_reserves", poolId, normalizeBigInts(r.value), r.resultXdr, r.latestLedger));
      const reserves = (Array.isArray(r.value) ? r.value : []).map((x) => BigInt(String(x)));
      info.reserves = reserves.map((x) => x.toString());
      info.tvl = reserves.reduce((a, b) => a + b, 0n).toString();
    } catch {
      /* no reserves getter */
    }
    try {
      const r = await client.simulate(poolId, "get_total_shares", []);
      sources.push(this.record("get_total_shares", poolId, normalizeBigInts(r.value), r.resultXdr, r.latestLedger));
      info.totalShares = String(r.value ?? "");
    } catch {
      /* no shares getter */
    }
    return { facts: info, sources };
  }

  private poolInfoFacts(info: PoolInfo, sources: SourceRecord[]): SemanticFact[] {
    const facts: SemanticFact[] = [];
    const led = sources[0]?.ledgerSeq;
    const add = (field: string, value: unknown, unit?: string) =>
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "aquarius",
          entityType: "pool",
          entityId: info.poolId,
          field,
          value,
          unit,
          ledgerSeq: led,
          sources,
          confidence: "high",
        }),
      );
    add("pool.exists", true, "bool");
    if (info.poolType) add("pool.type", info.poolType);
    if (info.poolType) add("pool.volatility", info.poolType === "stable_swap" ? "stable" : "volatile");
    if (info.feeBps !== undefined) add("pool.fee_bps", info.feeBps, "bps");
    if (info.tvl !== undefined) add("liquidity.depth", info.tvl, "stroops");
    if (info.totalShares !== undefined) add("pool.total_shares", info.totalShares, "shares");
    if (info.tickSpacing !== undefined) add("pool.tick_spacing", info.tickSpacing);
    return facts;
  }

  async getPools(req: GetPoolsRequest): Promise<ProtocolContext> {
    const { sorted, pools, source } = await this.discoverPools(req.tokenA, req.tokenB);
    const facts: SemanticFact[] = [];
    const allSources: SourceRecord[] = [source];

    for (const poolId of pools) {
      const { facts: info, sources } = await this.fetchPoolInfo(poolId);
      allSources.push(...sources);
      facts.push(...this.poolInfoFacts(info, sources.length ? sources : [source]));
    }
    if (!pools.length)
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "aquarius",
          entityType: "route",
          entityId: `aqua_pair:${sorted.join(":")}`,
          field: "pool.exists",
          value: false,
          unit: "bool",
          sources: [source],
          confidence: "high",
        }),
      );
    await this.persist(facts, allSources);
    return {
      protocol: "aquarius",
      network: this.ctx.network,
      facts,
      sourceRecords: allSources,
      warnings: pools.length ? [] : ["No Aquarius pool found for this pair."],
    };
  }

  async estimateSwap(req: EstimateSwapRequest): Promise<ProtocolContext> {
    const client = this.ctx.client;
    const cidIn = await client.assetContractId(req.tokenIn);
    const { sorted, pools, source } = await this.discoverPools(
      req.tokenIn,
      req.tokenOut,
    );
    const sources: SourceRecord[] = [source];
    const warnings: string[] = [];

    if (!pools.length) {
      const facts = [
        buildFact({
          network: this.ctx.network,
          protocol: "aquarius",
          entityType: "route",
          entityId: `aqua_route:${req.tokenIn}:${req.tokenOut}:${req.amountIn}`,
          field: "route.available",
          value: false,
          unit: "bool",
          sources,
          confidence: "high",
        }),
      ];
      await this.persist(facts, sources);
      return {
        protocol: "aquarius",
        network: this.ctx.network,
        facts,
        sourceRecords: sources,
        warnings: ["No Aquarius route for this pair."],
      };
    }

    const inIdx = sorted.indexOf(cidIn);
    const outIdx = inIdx === 0 ? 1 : 0;

    // Estimate across every candidate pool and pick the best output (the route
    // a router would choose). This is multi-pool best-route selection.
    let poolId = pools[0];
    let estimatedOut = -1n;
    let est: Awaited<ReturnType<typeof client.simulate>> | undefined;
    for (const candidate of pools) {
      try {
        const r = await client.simulate(candidate, "estimate_swap", [
          await client.u32(inIdx),
          await client.u32(outIdx),
          await client.u128(req.amountIn),
        ]);
        const out = BigInt(String(r.value ?? 0));
        sources.push(this.record("estimate_swap", candidate, normalizeBigInts(r.value), r.resultXdr, r.latestLedger));
        if (out > estimatedOut) {
          estimatedOut = out;
          poolId = candidate;
          est = r;
        }
      } catch (e) {
        warnings.push(`pool ${candidate.slice(0, 6)}… estimate failed: ${(e as Error).message.slice(0, 60)}`);
      }
    }
    if (!est || estimatedOut < 0n) {
      const facts = [
        buildFact({
          network: this.ctx.network,
          protocol: "aquarius",
          entityType: "route",
          entityId: `aqua_route:${req.tokenIn}:${req.tokenOut}:${req.amountIn}`,
          field: "route.available",
          value: false,
          unit: "bool",
          sources,
          confidence: "high",
        }),
      ];
      await this.persist(facts, sources);
      return {
        protocol: "aquarius",
        network: this.ctx.network,
        facts,
        sourceRecords: sources,
        warnings: [...warnings, "No Aquarius pool could price this swap."],
      };
    }

    // Reference estimate (small amount) to derive spot price -> slippage.
    let slip: number | undefined;
    try {
      const ref = bigMax(BigInt(req.amountIn) / 1000n, 1n);
      const refRes = await client.simulate(poolId, "estimate_swap", [
        await client.u32(inIdx),
        await client.u32(outIdx),
        await client.u128(ref.toString()),
      ]);
      sources.push(
        this.record("estimate_swap:ref", poolId, refRes.value, refRes.resultXdr, refRes.latestLedger),
      );
      const refOut = BigInt(String(refRes.value ?? 0));
      if (refOut > 0n && ref > 0n) {
        const idealOut = (BigInt(req.amountIn) * refOut) / ref;
        slip = Math.round(slippageBps(idealOut.toString(), estimatedOut.toString()));
      }
    } catch (e) {
      warnings.push(`slippage reference unavailable: ${(e as Error).message}`);
    }

    const entityId = `aqua_route:${req.tokenIn}:${req.tokenOut}:${req.amountIn}`;
    const facts: SemanticFact[] = [
      buildFact({
        network: this.ctx.network,
        protocol: "aquarius",
        entityType: "route",
        entityId,
        field: "slippage.estimated_out",
        value: estimatedOut.toString(),
        unit: "stroops",
        ledgerSeq: est.latestLedger,
        sources,
        confidence: "high",
      }),
      buildFact({
        network: this.ctx.network,
        protocol: "aquarius",
        entityType: "route",
        entityId,
        field: "route.hops",
        value: 1,
        unit: "count",
        sources,
        confidence: "high",
      }),
      buildFact({
        network: this.ctx.network,
        protocol: "aquarius",
        entityType: "route",
        entityId,
        field: "route.pool_id",
        value: poolId,
        sources,
        confidence: "high",
      }),
    ];
    if (slip !== undefined)
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "aquarius",
          entityType: "route",
          entityId,
          field: "slippage.estimated",
          value: slip,
          unit: "bps",
          ledgerSeq: est.latestLedger,
          sources,
          confidence: "high",
        }),
      );

    // Annotate the route with the winning pool's type/fee (spec §9.4).
    try {
      const { facts: info, sources: infoSources } = await this.fetchPoolInfo(poolId);
      sources.push(...infoSources);
      if (info.poolType)
        facts.push(
          buildFact({
            network: this.ctx.network,
            protocol: "aquarius",
            entityType: "route",
            entityId,
            field: "pool.type",
            value: info.poolType,
            sources: infoSources.length ? infoSources : sources,
            confidence: "high",
          }),
        );
      if (info.feeBps !== undefined)
        facts.push(
          buildFact({
            network: this.ctx.network,
            protocol: "aquarius",
            entityType: "route",
            entityId,
            field: "pool.fee_bps",
            value: info.feeBps,
            unit: "bps",
            sources: infoSources.length ? infoSources : sources,
            confidence: "high",
          }),
        );
    } catch {
      /* info optional */
    }

    await this.persist(facts, sources);
    return {
      protocol: "aquarius",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings,
    };
  }

  async createContext(req: {
    route?: EstimateSwapRequest;
    pools?: GetPoolsRequest;
  }): Promise<ProtocolContext> {
    if (req.route) return this.estimateSwap(req.route);
    if (req.pools) return this.getPools(req.pools);
    throw new Error("aquarius.createContext requires route or pools");
  }

  async ask(
    question: string,
    params: EstimateSwapRequest,
  ): Promise<SefiAnswer> {
    const ctx = await this.estimateSwap(params);
    const facts = ctx.facts;
    const capsule = await buildAndSaveCapsule(
      {
        network: this.ctx.network,
        protocols: ["aquarius"],
        facts,
        sourceRecords: ctx.sourceRecords,
      },
      this.ctx.store,
    );
    const fresh = checkFreshness(facts);
    const available = factValue(facts, "route.available");
    if (available === false) {
      return assembleAnswer({
        text: `No Aquarius route was found for ${params.tokenIn}->${params.tokenOut}.`,
        decision: "unsafe",
        recommendedActions: ["Try the Stellar DEX path instead"],
        facts,
        sourceRecords: ctx.sourceRecords,
        contextCapsuleId: capsule.id,
        warnings: [...ctx.warnings, "This is source-backed but not yet ZK-proven."],
      });
    }
    const slip = Number(factValue(facts, "slippage.estimated") ?? NaN);
    const hops = Number(factValue(facts, "route.hops") ?? 1);
    const out = String(factValue(facts, "slippage.estimated_out") ?? "0");
    const maxSlip = params.maxSlippageBps ?? MAX_SLIPPAGE_BPS;
    const slipOk = Number.isFinite(slip) ? slippageOk(slip, maxSlip) : false;
    const hopsOk = routeHopsOk(hops);
    const decision: SefiAnswer["decision"] =
      slipOk && hopsOk ? "safe" : Number.isFinite(slip) ? "conditional" : "unknown";

    const text =
      `Aquarius has a ${params.tokenIn}->${params.tokenOut} route with estimated output ${out} stroops` +
      (Number.isFinite(slip) ? `, estimated slippage ${(slip / 100).toFixed(2)}%` : "") +
      `, using ${hops} pool(s). ` +
      (slipOk
        ? `This is within the ${(maxSlip / 100).toFixed(2)}% slippage policy and is acceptable.`
        : Number.isFinite(slip)
          ? `Slippage exceeds the ${(maxSlip / 100).toFixed(2)}% policy; treat as conditional.`
          : `Slippage could not be derived; treat as unknown.`);

    return assembleAnswer({
      text,
      decision,
      recommendedActions: slipOk
        ? ["Proceed but re-simulate the swap before executing"]
        : ["Reduce trade size or split the route to lower slippage"],
      facts,
      sourceRecords: ctx.sourceRecords,
      contextCapsuleId: capsule.id,
      warnings: [
        ...ctx.warnings,
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

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

interface PoolInfo {
  poolId: string;
  poolType?: "constant_product" | "stable_swap" | "concentrated" | "unknown";
  feeBps?: number;
  tickSpacing?: number;
  reserves?: string[];
  tvl?: string;
  totalShares?: string;
}

function mapPoolType(t: unknown): PoolInfo["poolType"] {
  const s = String(t ?? "").toLowerCase();
  if (s.includes("stable")) return "stable_swap";
  if (s.includes("constant") || s.includes("standard") || s.includes("volatile"))
    return "constant_product";
  if (s.includes("concentrated") || s.includes("clmm")) return "concentrated";
  return "unknown";
}

/** Recursively convert BigInt -> string so values are JSON-serialisable for hashing. */
function normalizeBigInts(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(normalizeBigInts);
  if (v instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of v.entries()) o[String(k)] = normalizeBigInts(val);
    return o;
  }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      o[k] = normalizeBigInts(val);
    return o;
  }
  return v;
}
