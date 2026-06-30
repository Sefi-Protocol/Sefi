import type { SemanticFact } from "@sefi/shared-types";

/**
 * Per-field maximum age in seconds (spec §22.3: any answer involving liquidity,
 * slippage, or borrow risk must include freshness checks). Fields not listed
 * are not freshness-sensitive.
 */
export type FreshnessPolicy = Record<string, number>;

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  // Swap / route estimates change every ledger.
  "slippage.estimated_out": 20,
  "slippage.estimated": 20,
  "path.estimated_out": 20,
  "path.source_amount": 20,
  // Order-book / market data.
  "market.best_bid": 30,
  "market.best_ask": 30,
  "market.spread_bps": 30,
  "liquidity.depth_1pct": 30,
  "liquidity.depth_2pct": 30,
  // Lending risk state.
  "pool.utilization": 60,
  "health.factor": 60,
  "reserve.totalBorrowed": 60,
  "reserve.totalSupplied": 60,
  "oracle.freshness": 60,
};

export interface FreshnessResult {
  warnings: string[];
  staleFields: string[];
  /** Worst (largest) age observed among freshness-sensitive facts, in seconds. */
  maxAgeSeconds: number;
}

/**
 * Check that freshness-sensitive facts are within their max age. Live
 * on-demand facts have an age near zero, so this is a no-op then; for
 * background-ingested / cached facts it produces explicit warnings.
 */
export function checkFreshness(
  facts: SemanticFact[],
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
  nowMs: number = Date.now(),
): FreshnessResult {
  const warnings: string[] = [];
  const staleFields: string[] = [];
  let maxAgeSeconds = 0;
  const reported = new Set<string>();

  for (const f of facts) {
    const maxAge = policy[f.field];
    if (maxAge === undefined) continue;
    const created = Date.parse(f.createdAt);
    if (Number.isNaN(created)) continue;
    const ageSeconds = Math.max(0, (nowMs - created) / 1000);
    maxAgeSeconds = Math.max(maxAgeSeconds, ageSeconds);
    if (ageSeconds > maxAge && !reported.has(f.field)) {
      reported.add(f.field);
      staleFields.push(f.field);
      warnings.push(
        `${f.field} is ${ageSeconds.toFixed(0)}s old, older than the ${maxAge}s freshness threshold.`,
      );
    }
  }
  return { warnings, staleFields, maxAgeSeconds };
}
