import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIntent } from "./compile.js";
import { evaluateCompute } from "./evaluate.js";
import { FactNotFoundError } from "./bindings.js";
import { blendCapsule } from "./testutil.js";

const BLEND_COMPUTE =
  "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); safe = utilization < private.maxUtilization && blend.oracle.isFresh;";

function compileBlend(opts: Parameters<typeof blendCapsule>[0], maxUtil: string) {
  const { capsule, facts } = blendCapsule(opts);
  const compiled = compileIntent({
    intent: {
      name: "blend-utilization-policy",
      context: {},
      compute: BLEND_COMPUTE,
      privateInputs: { maxUtilization: maxUtil },
      reveal: ["safe"],
      hide: ["maxUtilization"],
      proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
    },
    capsule,
    facts,
  });
  return { compiled, facts };
}

test("utilization below threshold -> safe=true", () => {
  const { compiled, facts } = compileBlend(
    { totalBorrowed: "700000000000", totalSupplied: "1000000000000", oracle: "fresh" },
    "820000", // 0.82
  );
  const ev = evaluateCompute(compiled, { maxUtilization: "820000" }, facts);
  assert.equal(ev.revealed.safe, true); // 0.70 < 0.82 and fresh
});

test("utilization above threshold -> safe=false", () => {
  const { compiled, facts } = compileBlend(
    { totalBorrowed: "900000000000", totalSupplied: "1000000000000", oracle: "fresh" },
    "820000",
  );
  const ev = evaluateCompute(compiled, { maxUtilization: "820000" }, facts);
  assert.equal(ev.revealed.safe, false); // 0.90 > 0.82
});

test("oracle unknown -> safe=false", () => {
  const { compiled, facts } = compileBlend(
    { totalBorrowed: "100000000000", totalSupplied: "1000000000000", oracle: "unknown" },
    "820000",
  );
  const ev = evaluateCompute(compiled, { maxUtilization: "820000" }, facts);
  assert.equal(ev.revealed.safe, false);
});

test("division by zero guarded by max(totalSupplied, 1)", () => {
  const { compiled, facts } = compileBlend(
    { totalBorrowed: "0", totalSupplied: "0", oracle: "fresh" },
    "820000",
  );
  const ev = evaluateCompute(compiled, { maxUtilization: "820000" }, facts);
  assert.equal(ev.revealed.safe, true); // utilization 0 < 0.82
});

test("missing fact throws SEFI_COMPUTE_FACT_NOT_FOUND", () => {
  const { capsule, facts } = blendCapsule({
    totalBorrowed: "1",
    totalSupplied: "2",
    oracle: "fresh",
  });
  assert.throws(
    () =>
      compileIntent({
        intent: {
          name: "x",
          context: {},
          compute: "y = aquarius.estimatedOut >= private.minOut;",
          privateInputs: { minOut: "1" },
          reveal: ["y"],
          hide: ["minOut"],
          proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
        },
        capsule,
        facts,
      }),
    FactNotFoundError,
  );
});

test("resultHash is stable for same revealed result", () => {
  const a = compileBlend(
    { totalBorrowed: "700000000000", totalSupplied: "1000000000000", oracle: "fresh" },
    "820000",
  );
  const e1 = evaluateCompute(a.compiled, { maxUtilization: "820000" }, a.facts);
  const e2 = evaluateCompute(a.compiled, { maxUtilization: "820000" }, a.facts);
  assert.equal(e1.resultHash, e2.resultHash);
});
