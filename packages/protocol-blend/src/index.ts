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
  checkFreshness,
  factValue,
  riskDirection,
} from "@sefi/semantic-core";
import { buildAndSaveCapsule } from "@sefi/context-capsules";
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
      const cfg = r.config ?? {};
      // util / max_util are stored as 7-dp fixed point on chain.
      const utilizationCap =
        typeof cfg.max_util === "number" ? (cfg.max_util / 1e7).toFixed(4) : undefined;
      const supplyCap =
        cfg.supply_cap != null ? cfg.supply_cap.toString() : undefined;
      const emissionsPerSecond =
        r.supplyEmissions?.eps != null
          ? r.supplyEmissions.eps.toString()
          : undefined;
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
        utilizationCap,
        supplyCap,
        borrowApr: r.borrowApr != null ? String(r.borrowApr) : undefined,
        supplyApr: r.supplyApr != null ? String(r.supplyApr) : undefined,
        emissionsPerSecond,
        enabled: cfg.enabled,
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

    const backstop = await this.fetchBackstop(pool, poolId);

    const facts: BlendPoolFacts = {
      protocol: "blend",
      poolId,
      poolName: pool.metadata?.name,
      poolStatus: mapStatus(pool.metadata?.status ?? -1),
      reserves,
      oracle,
      backstop,
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

  /** Load pool backstop health via Backstop + BackstopPool estimate. */
  private async fetchBackstop(
    pool: any,
    poolId: string,
  ): Promise<BlendPoolFacts["backstop"]> {
    const backstopId: string | undefined = pool.metadata?.backstop;
    if (!backstopId) return { status: "unknown" };
    try {
      const sdk: any = await import("@blend-capital/blend-sdk");
      const network = this.ctx.client.blendNetwork();
      const backstop = await sdk.Backstop.load(network, backstopId);
      const loadPool = pool.version === sdk.Version?.V1 ? sdk.BackstopPoolV1 : sdk.BackstopPoolV2;
      const bp = await loadPool.load(network, backstopId, poolId);
      const est = sdk.BackstopPoolEst.build(backstop.backstopToken, bp.poolBalance);
      // Healthy when backstop value is meaningful and queued-for-withdrawal share is low.
      const q4w = est.q4wPercentage ?? 0;
      const status: "healthy" | "weak" =
        est.totalSpotValue > 0 && q4w < 0.5 ? "healthy" : "weak";
      return {
        contractId: backstopId,
        status,
        totalSpotValue: est.totalSpotValue,
        q4wPercentage: q4w,
      };
    } catch {
      return { contractId: backstopId, status: "unknown" };
    }
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
      const reserveFact = (field: string, value: unknown, unit?: string) =>
        facts.push(
          buildFact({
            network: this.ctx.network,
            protocol: "blend",
            entityType: "reserve",
            entityId,
            field,
            value,
            unit,
            ledgerSeq: pool.ledger,
            sources,
            confidence: "high",
          }),
        );
      reserveFact("pool.utilization", r.utilization, "ratio");
      reserveFact("reserve.totalSupplied", r.totalSupplied);
      reserveFact("reserve.totalBorrowed", r.totalBorrowed);
      if (r.utilizationCap !== undefined)
        reserveFact("reserve.utilizationCap", r.utilizationCap, "ratio");
      if (r.supplyCap !== undefined)
        reserveFact("reserve.supplyCap", r.supplyCap);
      if (r.collateralFactor)
        reserveFact("reserve.collateralFactor", r.collateralFactor, "ratio");
      if (r.liabilityFactor)
        reserveFact("reserve.liabilityFactor", r.liabilityFactor, "ratio");
      if (r.borrowApr !== undefined) reserveFact("reserve.borrowApr", r.borrowApr, "ratio");
      if (r.supplyApr !== undefined) reserveFact("reserve.supplyApr", r.supplyApr, "ratio");
      if (r.emissionsPerSecond !== undefined)
        reserveFact("reward.claimable", r.emissionsPerSecond, "eps");
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
    if (pool.backstop) {
      const bs = pool.backstop;
      facts.push(
        buildFact({
          network: this.ctx.network,
          protocol: "blend",
          entityType: "backstop",
          entityId: `backstop:${pool.poolId}`,
          field: "backstop.status",
          value: bs.status,
          ledgerSeq: pool.ledger,
          sources,
          confidence: bs.status === "unknown" ? "low" : "high",
        }),
      );
      if (bs.totalSpotValue !== undefined)
        facts.push(
          buildFact({
            network: this.ctx.network,
            protocol: "blend",
            entityType: "backstop",
            entityId: `backstop:${pool.poolId}`,
            field: "backstop.value",
            value: bs.totalSpotValue,
            unit: "usd",
            ledgerSeq: pool.ledger,
            sources,
            confidence: "high",
          }),
        );
    }
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

    const capsule = await buildAndSaveCapsule(
      {
        network: this.ctx.network,
        protocols: ["blend"],
        facts,
        sourceRecords: ctx.sourceRecords,
      },
      this.ctx.store,
    );
    const fresh = checkFreshness(facts);

    return assembleAnswer({
      text: parts.join(" "),
      decision,
      recommendedActions: recommended,
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
