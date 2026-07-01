import { test } from "node:test";
import assert from "node:assert/strict";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ArtifactsReady } from "./groth16.js";
import { aquariusFixture, circomInputFor, proveRaw, leakSurface } from "./groth16-fixtures.js";

const READY = groth16ArtifactsReady("aquarius-route-policy");
const skip = READY ? false : "aquarius_route circom zkey not built (run pnpm circom:setup)";

test("aquarius routeSafe=true when estimatedOut>=minOut and routeHops<=4", { skip }, async () => {
  const fx = aquariusFixture("100000000", 2, "99000000");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofEnvelope.backend, "bn254-groth16");
  assert.equal(result.proofCard.publicResult.routeAcceptable, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("aquarius routeSafe=false when estimatedOut<minOut", { skip }, async () => {
  const fx = aquariusFixture("50000000", 2, "99000000");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.routeAcceptable, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("aquarius routeSafe=false when routeHops>4", { skip }, async () => {
  const fx = aquariusFixture("100000000", 5, "99000000");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.routeAcceptable, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("aquarius: tampered estimatedOut fails the circuit (Merkle inclusion)", { skip }, async () => {
  const input = circomInputFor(aquariusFixture("100000000", 2, "99000000"));
  // Keep the committed Merkle path but change the value -> leaf no longer hashes to zkFactsRoot.
  input.estimated_out = "1";
  const r = await proveRaw("aquarius-route-policy", input);
  assert.equal(r, null, "circuit must reject a fact value that does not match its Merkle path");
});

test("aquarius: tampered routeHops fails the circuit (Merkle inclusion)", { skip }, async () => {
  const input = circomInputFor(aquariusFixture("100000000", 2, "99000000"));
  input.route_hops = "9";
  const r = await proveRaw("aquarius-route-policy", input);
  assert.equal(r, null, "circuit must reject a tampered routeHops");
});

test("aquarius: private minOut is not leaked", { skip }, async () => {
  const fx = aquariusFixture("100000000", 2, "123456789");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  const surface = leakSurface(result);
  assert.ok(!surface.includes("123456789"), "private minOut must never appear in the proof card / public inputs");
});
