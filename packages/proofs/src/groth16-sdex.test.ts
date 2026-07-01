import { test } from "node:test";
import assert from "node:assert/strict";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ArtifactsReady } from "./groth16.js";
import { sdexFixture, circomInputFor, proveRaw, leakSurface } from "./groth16-fixtures.js";

const READY = groth16ArtifactsReady("sdex-exit-policy");
const skip = READY ? false : "sdex_exit circom zkey not built (run pnpm circom:setup)";

test("sdex sdexSafe=true when pathAvailable and estimatedOut>=minReceive", { skip }, async () => {
  const fx = sdexFixture(true, "100000000", 500, "99000000", "50");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.exitOk, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("sdex sdexSafe=true when pathAvailable and spreadBps<=maxSpreadBps (output too low)", { skip }, async () => {
  const fx = sdexFixture(true, "1", 10, "99000000", "50");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.exitOk, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
});

test("sdex sdexSafe=false when pathAvailable is false", { skip }, async () => {
  const fx = sdexFixture(false, "100000000", 5, "99000000", "50");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.exitOk, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("sdex sdexSafe=false when output too low AND spread too high", { skip }, async () => {
  const fx = sdexFixture(true, "1", 999, "99000000", "50");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.exitOk, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("sdex: tampered spreadBps fails the circuit (Merkle inclusion)", { skip }, async () => {
  const input = circomInputFor(sdexFixture(true, "1", 999, "99000000", "50"));
  // Lower the spread so the predicate would flip, but keep the committed path.
  input.spread_bps = "5";
  const r = await proveRaw("sdex-exit-policy", input);
  assert.equal(r, null, "circuit must reject a tampered spreadBps");
});

test("sdex: tampered pathAvailable fails the circuit (Merkle inclusion)", { skip }, async () => {
  const input = circomInputFor(sdexFixture(false, "100000000", 5, "99000000", "50"));
  // Flip availability to true without a matching Merkle path.
  input.path_available = "1";
  const r = await proveRaw("sdex-exit-policy", input);
  assert.equal(r, null, "circuit must reject a tampered pathAvailable");
});

test("sdex: private thresholds are not leaked", { skip }, async () => {
  const fx = sdexFixture(true, "100000000", 5, "987654321", "7654321");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  const surface = leakSurface(result);
  assert.ok(!surface.includes("987654321"), "private minReceive must not leak");
  assert.ok(!surface.includes("7654321"), "private maxSpreadBps must not leak");
});
