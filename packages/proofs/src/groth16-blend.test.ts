import { test } from "node:test";
import assert from "node:assert/strict";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ArtifactsReady } from "./groth16.js";
import { blendFixture, circomInputFor, proveRaw, leakSurface } from "./groth16-fixtures.js";

const READY = groth16ArtifactsReady("blend-utilization-policy");
const skip = READY ? false : "blend_utilization circom zkey not built (run pnpm circom:setup)";

test("blend safe=true when utilization below private maxUtilization", { skip }, async () => {
  const fx = blendFixture("700000000000", "1000000000000", "fresh", "0.82");
  const { result, compiled } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.safe, true);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "1");
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("blend safe=false when utilization above private maxUtilization", { skip }, async () => {
  const fx = blendFixture("900000000000", "1000000000000", "fresh", "0.82");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.safe, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("blend safe=false when oracle is stale", { skip }, async () => {
  const fx = blendFixture("700000000000", "1000000000000", "stale", "0.82");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.safe, false);
  assert.equal(result.proofEnvelope.groth16!.publicSignals[0], "0");
});

test("blend: tampered fact value fails the circuit (Merkle inclusion)", { skip }, async () => {
  const input = circomInputFor(blendFixture("900000000000", "1000000000000", "fresh", "0.82"));
  // Reduce borrowed so utilization would look safe, but keep the committed path.
  input.borrowed = "1";
  const r = await proveRaw("blend-utilization-policy", input);
  assert.equal(r, null, "circuit must reject a fact value that does not match its Merkle path");
});

test("blend: tampered Merkle sibling fails the circuit", { skip }, async () => {
  const input = circomInputFor(blendFixture("700000000000", "1000000000000", "fresh", "0.82"));
  const path = input.borrowed_path as string[];
  path[0] = (BigInt(path[0] || "0") + 1n).toString();
  const r = await proveRaw("blend-utilization-policy", input);
  assert.equal(r, null, "circuit must reject a tampered Merkle sibling");
});

test("blend: tampered revealed result is rejected by verifyLocal", { skip }, async () => {
  const fx = blendFixture("700000000000", "1000000000000", "fresh", "0.82");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  assert.equal(result.proofCard.publicResult.safe, true);
  const forged = { ...result.proofEnvelope, revealed: { safe: false } };
  const v = await verifyLocal(forged);
  assert.equal(v.valid, false, "flipped revealed result must be rejected");
});

test("blend: private maxUtilization is not leaked", { skip }, async () => {
  const fx = blendFixture("700000000000", "1000000000000", "fresh", "0.837465");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  const surface = leakSurface(result);
  assert.ok(!surface.includes("0.837465") && !surface.includes("837465"), "private maxUtilization must not leak");
});
