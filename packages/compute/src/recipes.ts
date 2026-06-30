/**
 * First proof recipes (spec §10). Each is a named ComputeIntent template; the
 * DSL strings are fixed so `computeHash` is stable across runs.
 */

export const RECIPES = {
  "blend-utilization-policy":
    "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); " +
    "safe = utilization < private.maxUtilization && blend.oracle.isFresh;",

  "aquarius-route-policy":
    "routeAcceptable = aquarius.estimatedOut >= private.minOut && aquarius.routeHops <= 4;",

  "sdex-exit-policy":
    "pathOk = sdex.pathEstimatedOut >= private.minReceive; " +
    "spreadOk = sdex.spreadBps <= private.maxSpreadBps; " +
    "exitOk = sdex.pathAvailable && (pathOk || spreadOk);",

  "composite-borrow-exit-policy":
    "blendSafe = blend.healthAfterAction > private.minHealth; " +
    "aquaExit = aquarius.estimatedOut >= private.minReceive && aquarius.routeHops <= 4; " +
    "sdexExit = sdex.pathAvailable && sdex.pathEstimatedOut >= private.minReceive; " +
    "allowed = blendSafe && (aquaExit || sdexExit);",
} as const;

export type RecipeName = keyof typeof RECIPES;
