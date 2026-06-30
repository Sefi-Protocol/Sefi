/**
 * Pure protocol computations referenced by the spec (Blend §8.5, Aquarius §9.5,
 * SDEX §10.5). Kept dependency-free and deterministic so they are trivially
 * unit-testable and, later, re-expressible inside a ZK circuit.
 *
 * All ratio inputs are decimal strings/numbers; outputs are numbers unless a
 * spec field demands a string.
 */

function toNum(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** utilization = totalBorrowed / totalSupplied (0 when no supply). */
export function utilization(
  totalBorrowed: string | number,
  totalSupplied: string | number,
): number {
  const supplied = toNum(totalSupplied);
  if (supplied <= 0) return 0;
  return toNum(totalBorrowed) / supplied;
}

export interface CollateralLeg {
  value: string | number;
  factor: string | number; // collateral factor (<= 1)
}
export interface LiabilityLeg {
  value: string | number;
  factor: string | number; // liability factor (<= 1)
}

export interface BorrowCapacity {
  collateralAdjusted: number;
  liabilityAdjusted: number;
  borrowCapacityRemaining: number;
  healthFactor: number; // collateralAdjusted / liabilityAdjusted (Infinity when no debt)
}

/** Borrow safety math (spec §8.5). */
export function borrowCapacity(
  collateral: CollateralLeg[],
  liabilities: LiabilityLeg[],
): BorrowCapacity {
  const collateralAdjusted = collateral.reduce(
    (acc, c) => acc + toNum(c.value) * toNum(c.factor),
    0,
  );
  const liabilityAdjusted = liabilities.reduce((acc, l) => {
    const f = toNum(l.factor);
    return acc + (f > 0 ? toNum(l.value) / f : toNum(l.value));
  }, 0);
  const healthFactor =
    liabilityAdjusted <= 0 ? Infinity : collateralAdjusted / liabilityAdjusted;
  return {
    collateralAdjusted,
    liabilityAdjusted,
    borrowCapacityRemaining: collateralAdjusted - liabilityAdjusted,
    healthFactor,
  };
}

export type RiskDirection = "risk_increasing" | "risk_reducing" | "neutral";

/** Risk direction of an action (spec §8.5). */
export function riskDirection(action: string): RiskDirection {
  switch (action.toUpperCase()) {
    case "SUPPLY":
    case "REPAY":
      return "risk_reducing";
    case "BORROW":
    case "WITHDRAW":
      return "risk_increasing";
    default:
      return "neutral";
  }
}

/** spread_bps = ((bestAsk - bestBid) / midpoint) * 10000 (spec §10.5). */
export function spreadBps(
  bestBid: string | number,
  bestAsk: string | number,
): number {
  const bid = toNum(bestBid);
  const ask = toNum(bestAsk);
  const mid = (ask + bid) / 2;
  if (mid <= 0) return 0;
  return ((ask - bid) / mid) * 10000;
}

/** priceImpact / slippage in bps from quoted vs realised output. */
export function slippageBps(
  idealOut: string | number,
  estimatedOut: string | number,
): number {
  const ideal = toNum(idealOut);
  if (ideal <= 0) return 0;
  const est = toNum(estimatedOut);
  return Math.max(0, ((ideal - est) / ideal) * 10000);
}

/** route_acceptable = estimatedOut >= minOut (spec §9.5). */
export function routeAcceptable(
  estimatedOut: string | number,
  minOut: string | number,
): boolean {
  return toNum(estimatedOut) >= toNum(minOut);
}

/** slippage_ok = slippageBps <= maxSlippageBps (spec §9.5). */
export function slippageOk(slippage: number, maxSlippageBps: number): boolean {
  return slippage <= maxSlippageBps;
}

/** route_hops_ok = routeHops <= max (default 4, spec §9.5). */
export function routeHopsOk(hops: number, max = 4): boolean {
  return hops <= max;
}

/** Constant-product output for a single pool (x*y=k) net of fee, in same units. */
export function constantProductOut(
  reserveIn: string | number,
  reserveOut: string | number,
  amountIn: string | number,
  feeBps = 30,
): number {
  const rin = toNum(reserveIn);
  const rout = toNum(reserveOut);
  const ain = toNum(amountIn) * (1 - feeBps / 10000);
  if (rin <= 0 || rout <= 0 || ain <= 0) return 0;
  return (ain * rout) / (rin + ain);
}
