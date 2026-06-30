import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIntent } from "./compile.js";
import { evaluateCompute } from "./evaluate.js";
import { compositeCapsule } from "./testutil.js";

const COMPOSITE =
  "blendSafe = blend.healthAfterAction > private.minHealth; " +
  "aquaExit = aquarius.estimatedOut >= private.minReceive && aquarius.routeHops <= 4; " +
  "sdexExit = sdex.pathAvailable && sdex.pathEstimatedOut >= private.minReceive; " +
  "allowed = blendSafe && (aquaExit || sdexExit);";

function run(opts: Parameters<typeof compositeCapsule>[0], priv: Record<string, string>) {
  const { capsule, facts } = compositeCapsule(opts);
  const compiled = compileIntent({
    intent: {
      name: "composite-borrow-exit-policy",
      context: {},
      compute: COMPOSITE,
      privateInputs: priv,
      reveal: ["allowed"],
      hide: ["minHealth", "minReceive"],
      proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
    },
    capsule,
    facts,
  });
  const ev = evaluateCompute(compiled, priv, facts);
  return { compiled, ev };
}

test("binding resolves blend/aquarius/sdex paths to correct fields", () => {
  const { compiled } = run(
    { health: "1.42", aquaOut: "99000000", aquaHops: 2, sdexAvailable: true, sdexOut: "98000000" },
    { minHealth: "1.25", minReceive: "99000000" },
  );
  const byVar = Object.fromEntries(compiled.factRefs.map((b) => [b.variable, b.field]));
  assert.equal(byVar["blend.healthAfterAction"], "health.factor");
  assert.equal(byVar["aquarius.estimatedOut"], "slippage.estimated_out");
  assert.equal(byVar["aquarius.routeHops"], "route.hops");
  assert.equal(byVar["sdex.pathAvailable"], "path.available");
  assert.equal(byVar["sdex.pathEstimatedOut"], "path.estimated_out");
});

test("composite: Blend safe + Aqua ok -> allowed=true", () => {
  const { ev } = run(
    { health: "1.42", aquaOut: "99000000", aquaHops: 2, sdexAvailable: true, sdexOut: "10" },
    { minHealth: "1.25", minReceive: "99000000" },
  );
  assert.equal(ev.revealed.allowed, true);
});

test("composite: Blend safe + Aqua false + SDEX true -> allowed=true", () => {
  const { ev } = run(
    { health: "1.42", aquaOut: "1", aquaHops: 9, sdexAvailable: true, sdexOut: "99000000" },
    { minHealth: "1.25", minReceive: "99000000" },
  );
  assert.equal(ev.revealed.allowed, true);
});

test("composite: Blend unsafe + liquidity true -> allowed=false", () => {
  const { ev } = run(
    { health: "1.10", aquaOut: "99000000", aquaHops: 2, sdexAvailable: true, sdexOut: "99000000" },
    { minHealth: "1.25", minReceive: "99000000" },
  );
  assert.equal(ev.revealed.allowed, false);
});

test("every fact binding carries a Merkle proof bound to semanticFactsRoot", () => {
  const { compiled } = run(
    { health: "1.42", aquaOut: "99000000", aquaHops: 2, sdexAvailable: true, sdexOut: "98000000" },
    { minHealth: "1.25", minReceive: "99000000" },
  );
  for (const b of compiled.factRefs) {
    assert.ok(b.merkleProof, `binding ${b.variable} has merkle proof`);
    assert.equal(b.merkleProof!.root, compiled.semanticFactsRoot);
  }
});
