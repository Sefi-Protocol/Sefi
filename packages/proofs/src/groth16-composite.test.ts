import { test } from "node:test";
import assert from "node:assert/strict";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ArtifactsReady } from "./groth16.js";
import { compositeFixture, circomInputFor, proveRaw, leakSurface } from "./groth16-fixtures.js";

const READY = groth16ArtifactsReady("composite-borrow-exit-policy");
const skip = READY ? false : "composite_borrow_exit circom zkey not built (run pnpm circom:setup)";

// compositeFixture(health, estOut, hops, sdexAvail, pathOut, minHealth=1.25, minReceive=99000000)

test("composite allowed=true from a good Aquarius route", { skip }, async () => {
  const fx = compositeFixture("1.30", "100000000", 2, false, "0");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.allowed, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("composite allowed=true from the SDEX fallback (Aquarius route too small)", { skip }, async () => {
  const fx = compositeFixture("1.30", "1", 2, true, "100000000");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.allowed, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
});

test("composite allowed=false when Blend health is too low", { skip }, async () => {
  const fx = compositeFixture("1.10", "100000000", 2, true, "100000000");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.allowed, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("composite allowed=false when both exits fail", { skip }, async () => {
  const fx = compositeFixture("1.30", "1", 2, false, "1");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.allowed, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("composite allowed=false when routeHops>4 and SDEX is unavailable", { skip }, async () => {
  const fx = compositeFixture("1.30", "100000000", 5, false, "100000000");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.allowed, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("composite: tampered Blend health fails the circuit", { skip }, async () => {
  const input = circomInputFor(compositeFixture("1.10", "100000000", 2, true, "100000000"));
  // Raise health above the threshold without a matching Merkle path.
  input.health = "2000000";
  const r = await proveRaw("composite-borrow-exit-policy", input);
  assert.equal(r, null, "circuit must reject a tampered health value");
});

test("composite: tampered Aquarius output fails the circuit", { skip }, async () => {
  const input = circomInputFor(compositeFixture("1.30", "1", 2, false, "1"));
  input.estimated_out = "100000000";
  const r = await proveRaw("composite-borrow-exit-policy", input);
  assert.equal(r, null, "circuit must reject a tampered Aquarius estimatedOut");
});

test("composite: tampered SDEX path fails the circuit", { skip }, async () => {
  const input = circomInputFor(compositeFixture("1.30", "1", 2, false, "1"));
  input.path_available = "1";
  input.path_estimated_out = "100000000";
  const r = await proveRaw("composite-borrow-exit-policy", input);
  assert.equal(r, null, "circuit must reject a tampered SDEX path");
});

test("composite: private minHealth and minReceive are not leaked", { skip }, async () => {
  const fx = compositeFixture("1.30", "100000000", 2, false, "0", "1.234567", "918273645");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  const surface = leakSurface(result);
  assert.ok(!surface.includes("1234567"), "private minHealth must not leak");
  assert.ok(!surface.includes("918273645"), "private minReceive must not leak");
});
