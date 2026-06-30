import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { MemoryStore } from "@sefi/store";
import { SefiClient } from "@sefi/sdk";
import { createSefiTools, SEFI_AGENT_SYSTEM_PROMPT } from "./index.js";

const ADAPTER = "0x" + "a1".repeat(32);

async function seededClient() {
  const store = new MemoryStore();
  const src = buildSourceRecord({
    network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate",
    response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: ADAPTER,
  });
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

const proveIntent = (capsuleId: string) => ({
  name: "blend-utilization-policy",
  context: { capsuleId },
  compute: "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); safe = utilization < private.maxUtilization && blend.oracle.isFresh;",
  privateInputs: { maxUtilization: "0.82" },
  privateInputSchema: { maxUtilization: "fixed_1e6" as const },
  reveal: ["safe"], hide: ["maxUtilization"],
  proof: { backend: "prebuilt" as const, verifyOn: "offchain" as const, proveDataUsed: true },
});

test("system prompt encodes the ZK + privacy rules", () => {
  assert.match(SEFI_AGENT_SYSTEM_PROMPT, /bn254-noir/);
  assert.match(SEFI_AGENT_SYSTEM_PROMPT, /proof-of-data-used/);
  assert.match(SEFI_AGENT_SYSTEM_PROMPT, /Never reveal or echo private inputs/);
});

test("sefi_compute_prove tool output redacts private inputs", async () => {
  const { sefi, capsule } = await seededClient();
  const tools = createSefiTools(sefi);
  const prove = tools.find((t) => t.name === "sefi_compute_prove")!;
  const out = await prove.execute({ intent: proveIntent(capsule.id) });
  const json = JSON.stringify(out);
  assert.ok(!json.includes("820000"), "scaled private value must not appear");
  assert.ok(!json.includes("0.82"), "decimal private value must not appear");
  assert.equal((out as any).revealed.safe, true);
  // Only public fields exposed.
  assert.deepEqual(Object.keys(out as any).sort(), ["backend", "proofCard", "proofId", "publicInputs", "revealed"]);
});

test("sefi_compute_compile tool returns only public fields + private names", async () => {
  const { sefi, capsule } = await seededClient();
  const tools = createSefiTools(sefi);
  const compile = tools.find((t) => t.name === "sefi_compute_compile")!;
  const out = (await compile.execute({ intent: proveIntent(capsule.id) })) as any;
  const json = JSON.stringify(out);
  assert.ok(!json.includes("820000") && !json.includes("0.82"));
  assert.deepEqual(out.privateInputNames, ["maxUtilization"]);
});

test("BN254 prove tool fails (no toolchain) instead of silently using local-dev", async () => {
  const { sefi, capsule } = await seededClient();
  const tools = createSefiTools(sefi);
  const prove = tools.find((t) => t.name === "sefi_compute_prove")!;
  const { detectNoirToolchain } = await import("@sefi/proofs");
  const tc = await detectNoirToolchain();
  if (tc.nargo && tc.bb) return; // real proving path on configured machines
  await assert.rejects(
    () => prove.execute({ intent: { ...proveIntent(capsule.id), proof: { backend: "bn254-noir", verifyOn: "offchain", proveDataUsed: true } } }),
    /SEFI_BN254_TOOLCHAIN_MISSING/,
  );
});
