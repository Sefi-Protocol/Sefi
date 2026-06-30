import type {
  CompositeContext,
  Decision,
  SefiAnswer,
} from "@sefi/shared-types";
import { assembleAnswer, factValue } from "@sefi/semantic-core";

/**
 * Deterministic multi-protocol reasoner (spec §11.5). Combines Blend safety,
 * Aquarius route quality and SDEX fallback into one grounded answer. No LLM is
 * required; every clause is derived from facts in the composite context.
 */
export function reasonComposite(
  question: string,
  ctx: CompositeContext,
  warnings: string[],
): SefiAnswer {
  const facts = ctx.facts;

  // Blend: worst reserve utilization + oracle freshness + health factor.
  const utils = facts
    .filter((f) => f.protocol === "blend" && f.field === "pool.utilization")
    .map((f) => Number(f.value));
  const worstUtil = utils.length ? Math.max(...utils) : undefined;
  const oracle = factValue(facts, "oracle.freshness");
  const health = factValue(facts, "health.factor");

  // Aquarius route slippage.
  const aquaSlip = Number(
    factValue(
      facts.filter((f) => f.protocol === "aquarius"),
      "slippage.estimated",
    ) ?? NaN,
  );

  // SDEX fallback.
  const sdexAvailable = facts.some(
    (f) => f.field === "path.available" && f.value === true,
  );
  const sdexSpread = Number(factValue(facts, "market.spread_bps") ?? NaN);

  const blendSafe =
    worstUtil === undefined ? undefined : worstUtil <= 0.8;
  const aquaOk = Number.isFinite(aquaSlip) ? aquaSlip <= 100 : undefined;

  let decision: Decision = "unknown";
  if (blendSafe !== undefined && (aquaOk || sdexAvailable)) {
    decision = blendSafe && aquaOk ? "safe" : "conditional";
  } else if (blendSafe === false) {
    decision = "unsafe";
  }

  const parts: string[] = [];
  if (worstUtil !== undefined) {
    parts.push(
      `Blend: worst reserve utilization is ${(worstUtil * 100).toFixed(0)}% (${
        blendSafe ? "within" : "above"
      } the 80% threshold)${oracle ? `, oracle is ${oracle}` : ""}.`,
    );
  }
  if (health !== undefined) parts.push(`Position health factor is ${health}.`);
  if (Number.isFinite(aquaSlip)) {
    parts.push(
      `Aquarius offers a route with ~${(aquaSlip / 100).toFixed(2)}% slippage${
        aquaOk ? " (within policy)" : " (above 1% policy)"
      }.`,
    );
  }
  parts.push(
    sdexAvailable
      ? `Stellar DEX has a fallback path${
          Number.isFinite(sdexSpread) ? ` (spread ${sdexSpread} bps)` : ""
        }${
          Number.isFinite(sdexSpread) && sdexSpread > 50
            ? ", but it is wider, so the AMM route is preferred."
            : "."
        }`
      : "No Stellar DEX fallback path was found.",
  );
  if (decision === "conditional") {
    parts.push(
      "The action is conditionally safe: execute only if a final transaction simulation still confirms these values.",
    );
  }

  return assembleAnswer({
    text: parts.join(" "),
    decision,
    recommendedActions:
      decision === "safe"
        ? ["Proceed, re-simulating before execution"]
        : decision === "conditional"
          ? [
              "Borrow conservatively",
              "Prefer the Aquarius exit route",
              "Re-simulate before executing",
            ]
          : ["Do not borrow until liquidity/health improves"],
    facts,
    sourceRecords: ctx.sourceRecords,
    warnings: [...warnings, "This is source-backed but not yet ZK-proven."],
    contextCapsuleId: ctx.capsuleId,
  });
}
