import type {
  ProtocolContext,
  SefiAnswer,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import { buildSourceRecord, computeAdapterHash } from "@sefi/source-records";
import {
  assembleAnswer,
  buildFact,
  factValue,
  riskDirection,
} from "@sefi/semantic-core";
import type {
  AdapterContext,
  BlendPoolFacts,
  BlendUserPositionFacts,
  PoolContextRequest,
  UserContextRequest,
} from "./types.js";

export * from "./types.js";

const ADAPTER_NAME = "blend";
const ADAPTER_VERSION = "1.0.0";
const ADAPTER_HASH = computeAdapterHash(ADAPTER_NAME, ADAPTER_VERSION, "blend-live-v1");
const SAFE_UTILIZATION = 0.8; // spec §8.7

function mapStatus(status: number): BlendPoolFacts["poolStatus"] {
  // Blend pool status: 0/1 active, 2 on ice, >=3 frozen.
  if (status <= 1) return "active";
  if (status === 2) return "on_ice";
  if (status >= 3) return "frozen";
  return "unknown";
}

/**
 * Blend adapter (spec §8) — LIVE only. Loads real pool/reserve/oracle state via
 * the official `@blend-capital/blend-sdk` (which reads ledger entries over
 * Soroban RPC) and real user positions. No fixtures: it returns on-chain state
 * or throws.
 */
export class BlendAdapter {
  private symbolCache?: Map<string, string>;
  constructor(private ctx: AdapterContext) {}

  /** Resolve known asset contract ids -> symbols for nicer labels. */
  private async symbols(): Promise<Map<string, string>> {
    if (this.symbolCache) return this.symbolCache;
    const m = new Map<string, string>();
    for (const sym of ["XLM", "USDC", "AQUA"]) {
      try {
        m.set(await this.ctx.client.assetContractId(sym), sym);
      } catch {
        /* asset not in registry for this network */
      }
    }
    this.symbolCache = m;
    return m;
  }
  private label(assetId: string, symbols: Map<string, string>): string {
    return symbols.get(assetId) ?? `${assetId.slice(0, 6)}…${assetId.slice(-4)}`;
  }

  // ---- live fetch --------------------------------------------------------

  private async loadPool(poolId: string): Promise<any> {
    const sdk: any = await import("@blend-capital/blend-sdk");
    const network = this.ctx.client.blendNetwork();
    try {
      return await sdk.PoolV2.load(network, poolId);
    } catch {
      return await sdk.PoolV1.load(network, poolId);
    }
  }

  private async fetchPool(
    poolId: string,
  ): Promise<{ pool: BlendPoolFacts; sources: SourceRecord[] }> {
    const pool = await this.loadPool(poolId);
    const symbols = await this.symbols();
    const ledger = pool.metadata?.latestLedger;

    const reserves: BlendPoolFacts["reserves"] = [];
    for (const [assetId, r] of pool.reserves as Map<string, any>) {
      reserves.push({
        asset: assetId,
        symbol: this.label(assetId, symbols),
        totalSupplied: String(r.totalSupplyFloat?.() ?? r.totalSupply?.() ?? "0"),
        totalBorrowed: String(
          r.totalLiabilitiesFloat?.() ?? r.totalLiabilities?.() ?? "0",
        ),
        utilization: String(r.getUtilizationFloat?.() ?? 0),
        collateralFactor: String(r.getCollateralFactor?.() ?? ""),
        liabilityFactor: String(r.getLiabilityFactor?.() ?? ""),
      });
    }

    let oracle: BlendPoolFacts["oracle"];
    try {
      const o = await pool.loadOracle();
      oracle = {
        contractId: o.oracleId ?? pool.metadata?.oracle ?? poolId,
        status: "fresh",
        lastUpdatedLedger: o.latestLedger,
      };
    } catch {
      oracle = {
        contractId: pool.metadata?.oracle ?? poolId,
        status: "unknown",
      };
    }

    const facts: BlendPoolFacts = {
      protocol: "blend",
      poolId,
      poolName: pool.metadata?.name,
      poolStatus: mapStatus(pool.metadata?.status ?? -1),
      reserves,
      oracle,
      ledger,
    };

    const src = buildSourceRecord({
      network: this.ctx.network,
      protocol: "blend",
      sourceKind: "stellar_rpc_ledger_entries",
      contractId: poolId,
      functionName: "PoolV2.load",
      response: { metadata: serializableMeta(pool.metadata), reserves },
      ledgerSeq: ledger,
      latestLedger: ledger,
      adapterName: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: ADAPTER_HASH,
    });
    return { pool: facts, sources: [src] };
  }

  private async fetchUser(
    poolId: string,
    wallet: string,
  ): Promise<{ pos: BlendUserPositionFacts; sources: SourceRecord[] }> {
    const sdk: any = await import("@blend-capital/blend-sdk");
    const pool = await this.loadPool(poolId);
    const [oracle, user] = await Promise.all([
      pool.loadOracle(),
      pool.loadUser(wallet),
    ]);
    const est = sdk.PositionsEstimate.build(pool, oracle, user.positions);
    const liabilities = est.totalEffectiveLiabilities;
    const health =
      liabilities <= 0 ? Infinity : est.totalEffectiveCollateral / liabilities;
    const ledger = pool.metadata?.latestLedger;
    const pos: BlendUserPositionFacts = {
      poolId,
      wallet,
      totalEffectiveCollateral: est.totalEffectiveCollateral,
      totalEffectiveLiabilities: liabilities,
      borrowCapRemaining: est.borrowCap,
      healthFactor: health,
      ledger,
    };
    const src = buildSourceRecord({
      network: this.ctx.network,
      protocol: "blend",
      sourceKind: "stellar_rpc_ledger_entries",
      contractId: poolId,
      functionName: "loadUser",
      argsXdr: wallet,
      response: {
        totalEffectiveCollateral: est.totalEffectiveCollateral,
        totalEffectiveLiabilities: liabilities,
        borrowCap: est.borrowCap,
        borrowLimit: est.borrowLimit,
      },
      ledgerSeq: ledger,
      latestLedger: ledger,
      adapterName: ADAPTER_NAME,
      adapterVersion: ADAPTER_VERSION,
      adapterHash: ADAPTER_HASH,
    });
    return { pos, sources: [src] };
  }

  // ---- facts -------------------------------------------------------------

  private poolFacts(pool: BlendPoolFacts, sources: SourceRecord[]): SemanticFact[] {
    const facts: SemanticFact[] = [];
    const base = `blend_pool:${pool.poolId}`;
    facts.push(
      buildFact({
        network: this.ctx.network,
        protocol: "blend",
        entityType: "pool",
        entityId: base,
        field: "pool.status",
        value: pool.poolStatus,
        ledgerSeq: pool.ledger,
        sources,
        confidence: "high",
      }),
    );
    for (const r of pool.reserves) {
      const entityId = `${base}:${r.symbol}`;
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "blend",
          entityType: "reserve",
          entityId,
          field: "pool.utilization",
          value: r.utilization,
          unit: "ratio",
          ledgerSeq: pool.ledger,
          sources,
          confidence: "high",
        }),
        buildFact({
          network: this.ctx.network,
          protocol: "blend",
          entityType: "reserve",
          entityId,
          field: "reserve.totalSupplied",
          value: r.totalSupplied,
          ledgerSeq: pool.ledger,
          sources,
          confidence: "high",
        }),
        buildFact({
          network: this.ctx.network,
          protocol: "blend",
          entityType: "reserve",
          entityId,
          field: "reserve.totalBorrowed",
          value: r.totalBorrowed,
          ledgerSeq: pool.ledger,
          sources,
          confidence: "high",
        }),
      );
    }
    if (pool.oracle)
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "blend",
          entityType: "oracle",
          entityId: `oracle:${pool.oracle.contractId}`,
          field: "oracle.freshness",
          value: pool.oracle.status,
          ledgerSeq: pool.oracle.lastUpdatedLedger,
          sources,
          confidence: pool.oracle.status === "fresh" ? "high" : "low",
        }),
      );
    return facts;
  }

  private userFacts(
    pos: BlendUserPositionFacts,
    sources: SourceRecord[],
  ): SemanticFact[] {
    const entityId = `blend_position:${pos.poolId}:${pos.wallet}`;
    return [
      buildFact({
        network: this.ctx.network,
        protocol: "blend",
        entityType: "position",
        entityId,
        field: "health.factor",
        value: Number.isFinite(pos.healthFactor)
          ? pos.healthFactor.toFixed(4)
          : "Infinity",
        unit: "ratio",
        ledgerSeq: pos.ledger,
        sources,
        confidence: "high",
      }),
      buildFact({
        network: this.ctx.network,
        protocol: "blend",
        entityType: "position",
        entityId,
        field: "borrow.limit",
        value: pos.totalEffectiveCollateral.toString(),
        ledgerSeq: pos.ledger,
        sources,
        confidence: "high",
      }),
      buildFact({
        network: this.ctx.network,
        protocol: "blend",
        entityType: "position",
        entityId,
        field: "borrow.used",
        value: pos.totalEffectiveLiabilities.toString(),
        ledgerSeq: pos.ledger,
        sources,
        confidence: "high",
      }),
    ];
  }

  // ---- public API --------------------------------------------------------

  async getPoolContext(req: PoolContextRequest): Promise<ProtocolContext> {
    const warnings: string[] = [];
    const { pool, sources } = await this.fetchPool(req.poolId);
    let facts = this.poolFacts(pool, sources);
    const allSources = [...sources];

    if (req.wallet) {
      try {
        const u = await this.fetchUser(req.poolId, req.wallet);
        facts = facts.concat(this.userFacts(u.pos, u.sources));
        allSources.push(...u.sources);
      } catch (e) {
        warnings.push(`Blend user position unavailable: ${(e as Error).message}`);
      }
    }
    await this.persist(facts, allSources);
    return {
      protocol: "blend",
      network: this.ctx.network,
      facts,
      sourceRecords: allSources,
      warnings,
    };
  }

  async getUserContext(req: UserContextRequest): Promise<ProtocolContext> {
    const { pos, sources } = await this.fetchUser(req.poolId, req.wallet);
    const facts = this.userFacts(pos, sources);
    await this.persist(facts, sources);
    return {
      protocol: "blend",
      network: this.ctx.network,
      facts,
      sourceRecords: sources,
      warnings: [],
    };
  }

  async createContext(req: PoolContextRequest): Promise<ProtocolContext> {
    return this.getPoolContext(req);
  }

  async ask(
    question: string,
    params: { poolId: string; wallet?: string },
  ): Promise<SefiAnswer> {
    const ctx = await this.getPoolContext({
      poolId: params.poolId,
      wallet: params.wallet,
    });
    const facts = ctx.facts;

    const utilFacts = facts.filter((f) => f.field === "pool.utilization");
    let worst = { asset: "?", util: 0 };
    for (const f of utilFacts) {
      const u = Number(f.value);
      if (u >= worst.util)
        worst = { asset: f.entityId.split(":").pop() ?? "?", util: u };
    }
    const oracle = String(factValue(facts, "oracle.freshness") ?? "unknown");
    const health = factValue(facts, "health.factor");
    const risky = worst.util > SAFE_UTILIZATION;

    let decision: SefiAnswer["decision"] = "unknown";
    const recommended: string[] = [];
    const parts: string[] = [];
    if (utilFacts.length) {
      parts.push(
        `${worst.asset} utilization is ${(worst.util * 100).toFixed(0)}% (safe threshold ${(SAFE_UTILIZATION * 100).toFixed(0)}%).`,
      );
      if (risky) {
        decision = "conditional";
        parts.push("The pool is moderately risky because utilization exceeds the safe threshold.");
        recommended.push("Avoid new borrowing on the high-utilization reserve", "Add collateral or repay");
      } else {
        decision = "safe";
        parts.push("Utilization is within the safe band.");
      }
    }
    parts.push(
      oracle === "fresh"
        ? "Oracle status is fresh, so risk is utilization-driven, not oracle-driven."
        : `Oracle status is ${oracle}; treat price-derived values with caution.`,
    );
    if (health !== undefined) {
      const hf = Number(health);
      parts.push(
        `User health factor is ${health}${Number.isFinite(hf) && hf < 1.2 ? " — close to the warning zone." : "."}`,
      );
      if (/borrow/i.test(question))
        recommended.push(
          Number.isFinite(hf) && hf < 1.2
            ? "Borrowing more would increase liquidation risk"
            : "A small borrow keeps health above threshold; re-simulate before executing",
        );
    }

    return assembleAnswer({
      text: parts.join(" "),
      decision,
      recommendedActions: recommended,
      facts,
      sourceRecords: ctx.sourceRecords,
      warnings: [...ctx.warnings, "This is source-backed but not yet ZK-proven."],
    });
  }

  private async persist(facts: SemanticFact[], sources: SourceRecord[]) {
    if (!this.ctx.store) return;
    await this.ctx.store.saveSourceRecords(sources);
    await this.ctx.store.saveFacts(facts);
  }
}

function serializableMeta(meta: any) {
  if (!meta) return null;
  return {
    name: meta.name,
    status: meta.status,
    oracle: meta.oracle,
    backstop: meta.backstop,
    reserveList: meta.reserveList,
    latestLedger: meta.latestLedger,
  };
}

export const blendRiskDirection = riskDirection;
