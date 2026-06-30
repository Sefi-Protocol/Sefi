/**
 * The unified semantic vocabulary (spec §6). Adapters MUST map raw protocol
 * data onto these entities, actions, fields and units so that cross-protocol
 * reasoning works against one vocabulary.
 */

export const UNIVERSAL_ENTITIES = [
  "Asset",
  "Account",
  "Protocol",
  "Pool",
  "Reserve",
  "Market",
  "Position",
  "Route",
  "Offer",
  "Trade",
  "LiquidityPool",
  "Oracle",
  "Backstop",
  "Reward",
  "Action",
  "RiskMetric",
  "Constraint",
  "SourceRecord",
  "ContextCapsule",
] as const;

export const UNIVERSAL_ACTIONS = [
  "SUPPLY",
  "WITHDRAW",
  "BORROW",
  "REPAY",
  "SWAP",
  "ROUTE",
  "LP_DEPOSIT",
  "LP_WITHDRAW",
  "CLAIM_REWARD",
  "PLACE_OFFER",
  "CANCEL_OFFER",
  "PATH_PAYMENT",
] as const;

/** Canonical risk-metric field names (spec §6.3). */
export const RISK_FIELDS = {
  poolUtilization: "pool.utilization",
  borrowLimit: "borrow.limit",
  borrowUsed: "borrow.used",
  healthFactor: "health.factor",
  oracleFreshness: "oracle.freshness",
  liquidityDepth: "liquidity.depth",
  liquidityAvailable: "liquidity.available",
  slippageEstimated: "slippage.estimated",
  marketSpreadBps: "market.spread_bps",
  routeHops: "route.hops",
  rewardClaimable: "reward.claimable",
  positionExposure: "position.exposure",
  assetApproved: "asset.approved",
} as const;

export const UNITS = {
  ratio: "ratio",
  bps: "bps",
  stroops: "stroops",
  shares: "shares",
  count: "count",
  bool: "bool",
} as const;
