import type {
  FactBinding,
  Protocol,
  SefiScalarType,
  SemanticFact,
} from "@sefi/shared-types";
import { hashSemanticFact } from "@sefi/source-records";

/**
 * Fact reference binding map (spec §6). Maps a DSL fact path
 * (e.g. blend.reserve.USDC.totalBorrowed) onto a concrete semantic fact in the
 * selected context capsule. Missing facts throw SEFI_COMPUTE_FACT_NOT_FOUND —
 * never silently default to zero (spec §6 / §20).
 */

export class FactNotFoundError extends Error {
  constructor(path: string, capsuleId: string) {
    super(`SEFI_COMPUTE_FACT_NOT_FOUND: ${path} was not found in capsule ${capsuleId}`);
    this.name = "FactNotFoundError";
  }
}

interface Selector {
  protocol: Protocol;
  entityType: string;
  field: string;
  valueType: SefiScalarType;
  /** Match a fact among candidates (e.g. by symbol in entityId). */
  match?: (fact: SemanticFact, parts: string[]) => boolean;
}

/** Resolve a dotted DSL path to a fact selector. `parts` is the split path. */
function selectorFor(parts: string[]): Selector | null {
  const [root] = parts;

  if (root === "blend") {
    // blend.reserve.<SYMBOL>.<metric>
    if (parts[1] === "reserve" && parts.length === 4) {
      const symbol = parts[2];
      const metric = parts[3];
      const fieldMap: Record<string, { field: string; type: SefiScalarType }> = {
        totalSupplied: { field: "reserve.totalSupplied", type: "u128" },
        totalBorrowed: { field: "reserve.totalBorrowed", type: "u128" },
        utilization: { field: "pool.utilization", type: "fixed_1e6" },
      };
      const m = fieldMap[metric];
      if (!m) return null;
      return {
        protocol: "blend",
        entityType: "reserve",
        field: m.field,
        valueType: m.type,
        match: (f) => f.entityId.includes(`:${symbol}`),
      };
    }
    if (parts[1] === "oracle" && parts[2] === "isFresh") {
      return { protocol: "blend", entityType: "oracle", field: "oracle.freshness", valueType: "bool" };
    }
    if (parts[1] === "healthAfterAction")
      return { protocol: "blend", entityType: "position", field: "health.factor", valueType: "fixed_1e6" };
    if (parts[1] === "borrowLimit")
      return { protocol: "blend", entityType: "position", field: "borrow.limit", valueType: "u128" };
    if (parts[1] === "liabilityUsed")
      return { protocol: "blend", entityType: "position", field: "borrow.used", valueType: "u128" };
  }

  if (root === "aquarius") {
    if (parts[1] === "estimatedOut")
      return { protocol: "aquarius", entityType: "route", field: "slippage.estimated_out", valueType: "u128" };
    if (parts[1] === "slippageBps")
      return { protocol: "aquarius", entityType: "route", field: "slippage.estimated", valueType: "u64" };
    if (parts[1] === "routeHops")
      return { protocol: "aquarius", entityType: "route", field: "route.hops", valueType: "u64" };
    if (parts[1] === "routeAvailable")
      return { protocol: "aquarius", entityType: "route", field: "route.available", valueType: "bool" };
  }

  if (root === "sdex") {
    if (parts[1] === "pathAvailable")
      return { protocol: "stellar_dex", entityType: "route", field: "path.available", valueType: "bool" };
    if (parts[1] === "pathEstimatedOut")
      return { protocol: "stellar_dex", entityType: "route", field: "path.estimated_out", valueType: "u128" };
    if (parts[1] === "spreadBps")
      return { protocol: "stellar_dex", entityType: "market", field: "market.spread_bps", valueType: "u64" };
    if (parts[1] === "bestBid")
      return { protocol: "stellar_dex", entityType: "market", field: "market.best_bid", valueType: "fixed_1e6" };
    if (parts[1] === "bestAsk")
      return { protocol: "stellar_dex", entityType: "market", field: "market.best_ask", valueType: "fixed_1e6" };
  }

  return null;
}

/** Resolve one fact path against the capsule facts, producing a FactBinding. */
export function bindFact(
  variable: string,
  parts: string[],
  facts: SemanticFact[],
  capsuleId: string,
): { binding: FactBinding; fact: SemanticFact } {
  const sel = selectorFor(parts);
  const pathStr = parts.join(".");
  if (!sel) throw new FactNotFoundError(pathStr, capsuleId);

  const candidates = facts.filter(
    (f) =>
      f.protocol === sel.protocol &&
      f.entityType === sel.entityType &&
      f.field === sel.field &&
      (!sel.match || sel.match(f, parts)),
  );
  const fact = candidates[0];
  if (!fact) throw new FactNotFoundError(pathStr, capsuleId);
  if (!fact.sourceRecordIds || fact.sourceRecordIds.length === 0)
    throw new Error(`SEFI_COMPUTE_FACT_NO_SOURCE: ${pathStr} has no source records`);

  const entitySelector: Record<string, string> = {
    entityId: fact.entityId,
  };
  const binding: FactBinding = {
    variable,
    protocol: sel.protocol,
    entityType: sel.entityType,
    entitySelector,
    field: sel.field,
    valueType: sel.valueType,
    factId: fact.id,
    factHash: hashSemanticFact(fact) as `0x${string}`,
  };
  return { binding, fact };
}
