import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIntent, ComputeCompileError } from "./compile.js";
import { evaluateCompute } from "./evaluate.js";
import { blendCapsule } from "./testutil.js";

function build() {
  const { capsule, facts } = blendCapsule({
    totalBorrowed: "700000000000",
    totalSupplied: "1000000000000",
    oracle: "fresh",
  });
  return { capsule, facts };
}

test("compiled intent never contains private values", () => {
  const { capsule, facts } = build();
  const compiled = compileIntent({
    intent: {
      name: "p",
      context: {},
      compute: "safe = blend.reserve.USDC.totalBorrowed < private.maxUtilization;",
      privateInputs: { maxUtilization: "820000" },
      reveal: ["safe"],
      hide: ["maxUtilization"],
      proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
    },
    capsule,
    facts,
  });
  const serialized = JSON.stringify(compiled);
  assert.ok(!serialized.includes("820000"), "private value leaked into compiled intent");
  assert.ok(compiled.privateInputSchema.maxUtilization, "schema records the name only");
});

test("evaluation output/revealed never contains private values", () => {
  const { capsule, facts } = build();
  const compiled = compileIntent({
    intent: {
      name: "p",
      context: {},
      compute: "safe = blend.reserve.USDC.totalBorrowed < private.maxUtilization;",
      privateInputs: { maxUtilization: "820000" },
      reveal: ["safe"],
      hide: ["maxUtilization"],
      proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
    },
    capsule,
    facts,
  });
  const ev = evaluateCompute(compiled, { maxUtilization: "820000" }, facts);
  const serialized = JSON.stringify({ revealed: ev.revealed, outputs: ev.outputs });
  assert.ok(!serialized.includes("820000"), "private value leaked into evaluation");
  assert.deepEqual(Object.keys(ev.revealed), ["safe"]);
  assert.deepEqual(ev.hiddenUsed, ["maxUtilization"]);
});

test("revealing a private input is rejected at compile", () => {
  const { capsule, facts } = build();
  assert.throws(
    () =>
      compileIntent({
        intent: {
          name: "p",
          context: {},
          compute: "safe = private.maxUtilization > 0;",
          privateInputs: { maxUtilization: "820000" },
          reveal: ["private.maxUtilization"],
          hide: [],
          proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
        },
        capsule,
        facts,
      }),
    ComputeCompileError,
  );
});
