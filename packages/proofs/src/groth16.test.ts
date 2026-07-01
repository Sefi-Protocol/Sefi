import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { compileIntent, evaluateCompute, RECIPES } from "@sefi/compute";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";
import { groth16ToSoroban, groth16ArtifactsReady } from "./groth16.js";

const ADAPTER = "0x" + "a1".repeat(32);

function blendFixture(borrowed: string, supplied: string, oracle: string) {
  const src = buildSourceRecord({
    network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate",
    response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: ADAPTER,
  });
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: borrowed, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: supplied, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: oracle, sources: [src] }),
  ];
  return { capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] }), facts };
}

function intent(): ComputeIntent {
  return {
    name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"],
    privateInputs: { maxUtilization: "0.82" }, privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"], hide: ["maxUtilization"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  };
}

const READY = groth16ArtifactsReady("blend-utilization-policy");

test("REAL Sefi compute proof: bn254-groth16 prove + verify + Soroban serialize", { skip: READY ? false : "circom zkey not built (run pnpm circom:setup)" }, async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result, compiled } = await proveComputeIntent({ intent: intent(), capsule, facts });

  // Real ZK proof of the actual ComputeIntent.
  assert.equal(result.proofEnvelope.backend, "bn254-groth16");
  assert.equal(result.proofCard.publicResult.safe, true);
  assert.ok(result.proofEnvelope.groth16, "groth16 artifacts attached");
  // Public signals carry the capsule's zk roots.
  const ps = result.proofEnvelope.groth16!.publicSignals;
  assert.equal(ps[0], "1", "circuit output safe == 1 matches evaluator");
  assert.equal(BigInt(result.proofEnvelope.publicInputs.zkContextRoot!).toString(10), ps[1]);
  assert.equal(BigInt(result.proofEnvelope.publicInputs.zkFactsRoot!).toString(10), ps[2]);

  // No private input leaks.
  const json = JSON.stringify(result);
  assert.ok(!json.includes("820000") && !json.includes("0.82"), "private input must not appear");

  // Real cryptographic verification (snarkjs).
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));

  // Soroban serialization has the right byte lengths (EIP-197).
  const sor = groth16ToSoroban(result.proofEnvelope.groth16 as any);
  assert.equal(sor.proof.a.length, 128, "G1 = 64 bytes hex");
  assert.equal(sor.proof.b.length, 256, "G2 = 128 bytes hex");
  assert.equal(sor.proof.c.length, 128);
  assert.equal(sor.vk.ic.length, ps.length + 1, "IC has one base point plus one per public signal");
  assert.equal(sor.publicInputs.length, ps.length);
});

test("groth16 verifyLocal rejects a tampered public signal", { skip: READY ? false : "circom zkey not built" }, async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: intent(), capsule, facts });
  // Tamper the envelope's committed zkFactsRoot so it no longer matches the proof's public signal.
  const tampered = {
    ...result.proofEnvelope,
    publicInputs: { ...result.proofEnvelope.publicInputs, zkFactsRoot: ("0x" + "0".repeat(64)) as `0x${string}` },
  };
  const v = await verifyLocal(tampered);
  assert.equal(v.valid, false);
});

test("SECURITY: verifyLocal rejects a proof paired with a FLIPPED revealed result", { skip: READY ? false : "circom zkey not built" }, async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: intent(), capsule, facts });
  assert.equal(result.proofCard.publicResult.safe, true);
  // Attacker keeps the valid proof (safe=1) but flips the claimed revealed result.
  const forged = { ...result.proofEnvelope, revealed: { safe: false } };
  const v = await verifyLocal(forged);
  assert.equal(v.valid, false, "flipped revealed result must be rejected");
  assert.ok(v.reasons.some((r) => /proven result .* does not match revealed result/.test(r)), v.reasons.join("; "));
});

test("SECURITY: verifyLocal rejects an envelope revealing more than one output", { skip: READY ? false : "circom zkey not built" }, async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: intent(), capsule, facts });
  const forged = { ...result.proofEnvelope, revealed: { safe: true, extra: true } };
  const v = await verifyLocal(forged);
  assert.equal(v.valid, false);
});

test("bn254-groth16 throws (no silent fallback) when the zkey is missing", { skip: READY ? "zkey present in this env" : false }, async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  await assert.rejects(() => proveComputeIntent({ intent: intent(), capsule, facts }), /SEFI_GROTH16_ARTIFACTS_MISSING/);
});
