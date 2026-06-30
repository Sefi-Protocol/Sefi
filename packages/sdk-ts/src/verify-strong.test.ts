import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputeIntent, SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { MemoryStore } from "@sefi/store";
import { SefiClient } from "./index.js";

const ADAPTER = "0x" + "a1".repeat(32);

function blendFixture(borrowed: string, supplied: string, oracle: string) {
  const src = buildSourceRecord({
    network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate",
    response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend",
    adapterVersion: "1.0.0", adapterHash: ADAPTER,
  });
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: borrowed, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: supplied, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: oracle, sources: [src] }),
  ];
  return { src, facts, capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] }) };
}

function intent(capsuleId: string): ComputeIntent {
  return {
    name: "blend-utilization-policy",
    context: { capsuleId },
    compute: "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); safe = utilization < private.maxUtilization && blend.oracle.isFresh;",
    privateInputs: { maxUtilization: "0.82" },
    privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"], hide: ["maxUtilization"],
    // Deterministic backend for verification tests (no toolchain needed).
    proof: { backend: "prebuilt", verifyOn: "offchain", proveDataUsed: true },
  };
}

async function seed(borrowed: string, supplied: string, oracle: string) {
  const store = new MemoryStore();
  const { src, facts, capsule } = blendFixture(borrowed, supplied, oracle);
  await store.saveSourceRecords([src]);
  await store.saveFacts(facts);
  await store.saveCapsule(capsule);
  const sefi = new SefiClient({ network: "mainnet" }, store);
  return { store, sefi, capsule, facts };
}

test("prove over stored capsuleId succeeds and verifies strongly", async () => {
  const { sefi, capsule } = await seed("700000000000", "1000000000000", "fresh");
  const r = await sefi.compute().prove(intent(capsule.id));
  assert.equal(r.proofCard.publicResult.safe, true);
  const v = await sefi.verify().local(r.proofEnvelope);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("proof fails if a stored fact is tampered after proving", async () => {
  const { sefi, store, capsule, facts } = await seed("700000000000", "1000000000000", "fresh");
  const r = await sefi.compute().prove(intent(capsule.id));
  // tamper: overwrite a fact value in the store
  const tampered = { ...facts[0], value: "999999999999" };
  await store.saveFacts([tampered as any]);
  // overwrite map entry (saveFacts upserts by id)
  (store as any).facts.set(tampered.id, tampered);
  const v = await sefi.verify().local(r.proofEnvelope);
  assert.equal(v.valid, false);
  assert.ok(v.reasons.some((x) => /capsule roots failed/.test(x)));
});

test("strong verify rejects envelope with mismatched computeHash", async () => {
  const { sefi, capsule } = await seed("700000000000", "1000000000000", "fresh");
  const r = await sefi.compute().prove(intent(capsule.id));
  const bad = { ...r.proofEnvelope, publicInputs: { ...r.proofEnvelope.publicInputs, computeHash: ("0x" + "0".repeat(64)) as `0x${string}` } };
  const v = await sefi.verify().local(bad);
  assert.equal(v.valid, false);
});

test("envelope-only verification is rejected unless dev=true", async () => {
  const { sefi, capsule } = await seed("700000000000", "1000000000000", "fresh");
  const r = await sefi.compute().prove(intent(capsule.id));
  const weak = await sefi.verify().local(r.proofEnvelope, { compiledIntentId: undefined });
  // No compiledIntentId provided and no dev flag -> strong path can still find via capsule? It cannot match by hash, so:
  // We pass an unknown envelope (simulate external) by clearing store linkage:
  const external = { ...r.proofEnvelope };
  const vExternalStrong = await new SefiClient({ network: "mainnet" }, new MemoryStore()).verify().local(external);
  assert.equal(vExternalStrong.valid, false, "no bound intent -> invalid without dev");
  const vExternalDev = await new SefiClient({ network: "mainnet" }, new MemoryStore()).verify().local(external, { dev: true });
  assert.ok(vExternalDev.valid, "dev mode allows envelope-only checksum verification");
  void weak;
});

test("proving against an unverified (tampered) capsule is rejected", async () => {
  const { sefi, store, capsule } = await seed("700000000000", "1000000000000", "fresh");
  // tamper a stored fact so capsule roots no longer match before proving
  const facts = await store.getCapsuleFacts(capsule.id);
  (store as any).facts.set(facts[0].id, { ...facts[0], value: "1" });
  await assert.rejects(() => sefi.compute().prove(intent(capsule.id)), /SEFI_COMPUTE_CAPSULE_UNVERIFIED/);
});
