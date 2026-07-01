import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { ProofEnvelope } from "@sefi/shared-types";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ArtifactsReady, groth16ArtifactPaths } from "./groth16.js";
import { blendFixture } from "./groth16-fixtures.js";

const READY = groth16ArtifactsReady("blend-utilization-policy");
const skip = READY ? false : "circom zkey not built (run pnpm circom:setup)";

async function goodProof() {
  const fx = blendFixture("700000000000", "1000000000000", "fresh", "0.82");
  const { result } = await proveComputeIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  return result.proofEnvelope;
}

function clone(e: ProofEnvelope): ProofEnvelope {
  return JSON.parse(JSON.stringify(e));
}

test("SECURITY: a clean proof verifies (control)", { skip }, async () => {
  const e = await goodProof();
  const v = await verifyLocal(e);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("SECURITY: flipping the revealed result is rejected", { skip }, async () => {
  const e = await goodProof();
  const v = await verifyLocal({ ...e, revealed: { safe: false } });
  assert.equal(v.valid, false);
});

test("SECURITY: changing resultHash is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  e.publicInputs.resultHash = ("0x" + "1".repeat(64)) as `0x${string}`;
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: changing computeHash is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  e.publicInputs.computeHash = ("0x" + "2".repeat(64)) as `0x${string}`;
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: changing zkFactsRoot is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  e.publicInputs.zkFactsRoot = ("0x" + "3".repeat(64)) as `0x${string}`;
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: changing zkContextRoot is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  e.publicInputs.zkContextRoot = ("0x" + "4".repeat(64)) as `0x${string}`;
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: changing a public signal is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  // Flip the circuit output signal; the proof no longer verifies against it.
  e.groth16!.publicSignals[0] = e.groth16!.publicSignals[0] === "1" ? "0" : "1";
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: tampering the proof bytes is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  const proof: any = e.groth16!.proof;
  proof.pi_a[0] = (BigInt(proof.pi_a[0]) + 1n).toString();
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});

test("SECURITY: using the wrong verifier key is rejected", { skip }, async () => {
  const e = clone(await goodProof());
  // Swap in a different circuit's verification key (aquarius). Pairing check fails.
  const other = groth16ArtifactPaths("aquarius-route-policy");
  e.groth16!.vkey = JSON.parse(await readFile(other.vkey, "utf8"));
  const v = await verifyLocal(e);
  assert.equal(v.valid, false);
});
