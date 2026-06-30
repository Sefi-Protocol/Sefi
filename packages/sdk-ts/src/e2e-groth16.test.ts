import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady, groth16ToSoroban } from "@sefi/proofs";
import { MemoryStore } from "@sefi/store";
import { SefiClient } from "./index.js";

const READY = groth16ArtifactsReady("blend-utilization-policy");
const ADAPTER = "0x" + "a1".repeat(32);

async function seed() {
  const store = new MemoryStore();
  const src = buildSourceRecord({ network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: ADAPTER });
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] });
  await store.saveSourceRecords([src]);
  await store.saveFacts(facts);
  await store.saveCapsule(capsule);
  return { sefi: new SefiClient({ network: "mainnet" }, store), capsule };
}

const intent = (capsuleId: string): ComputeIntent => ({
  name: "blend-utilization-policy",
  context: { capsuleId },
  compute: RECIPES["blend-utilization-policy"],
  privateInputs: { maxUtilization: "0.82" },
  privateInputSchema: { maxUtilization: "fixed_1e6" },
  reveal: ["safe"], hide: ["maxUtilization"],
  proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
});

test(
  "END-TO-END: capsule -> compile -> real Groth16 proof -> verify -> Soroban-ready (stellar_verified path)",
  { skip: READY ? false : "circom artifacts missing (run pnpm circom:setup)" },
  async () => {
    const { sefi, capsule } = await seed();

    // Prove the actual ComputeIntent over the stored, verified capsule.
    const result = await sefi.compute().prove(intent(capsule.id));
    assert.equal(result.proofEnvelope.backend, "bn254-groth16");
    assert.equal(result.proofCard.publicResult.safe, true);
    assert.ok(result.proofEnvelope.groth16, "real Groth16 artifacts present");

    // Real cryptographic verification through the SDK.
    const v = await sefi.verify().local(result.proofEnvelope);
    assert.ok(v.valid, v.reasons.join("; "));

    // The proof is ready for on-chain verification (Soroban byte layout).
    const sor = groth16ToSoroban(result.proofEnvelope.groth16 as any);
    assert.equal(sor.proof.a.length, 128);
    assert.equal(sor.proof.b.length, 256);
    assert.equal(sor.vk.ic.length, sor.publicInputs.length + 1);

    // onStellar without a configured verifier reports not_configured (honest),
    // never a false stellar_verified.
    const prev = process.env.SEFI_VERIFIER_CONTRACT_ID;
    delete process.env.SEFI_VERIFIER_CONTRACT_ID;
    const s = await sefi.verify().onStellar(result.proofEnvelope);
    assert.equal(s.verificationMode, "not_configured");
    if (prev) process.env.SEFI_VERIFIER_CONTRACT_ID = prev;

    // No private input leaks anywhere.
    assert.ok(!JSON.stringify(result).includes("0.82") && !JSON.stringify(result).includes("820000"));
  },
);
