/**
 * Phase 3 API acceptance: prove all four recipes over /v1/compute/prove-bn254,
 * verify locally, retrieve the proof card, exercise the on-chain request shape,
 * and confirm no private input is ever returned by the API.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { MemoryStore } from "@sefi/store";
import { SefiClient } from "@sefi/sdk";
import { buildApp } from "./index.js";

const READY = groth16ArtifactsReady("blend-utilization-policy") &&
  groth16ArtifactsReady("aquarius-route-policy") &&
  groth16ArtifactsReady("sdex-exit-policy") &&
  groth16ArtifactsReady("composite-borrow-exit-policy");

const rec = (p: any) => buildSourceRecord({ network: "mainnet", protocol: p, sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: String(p), adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });

let server: Server;
let base = "";
let store: MemoryStore;
const capsuleIds: Record<string, string> = {};

function seedAll(s: MemoryStore) {
  const save = async (protocols: any[], facts: SemanticFact[], sources: any[], recipe: string) => {
    const capsule = buildCapsule({ network: "mainnet", protocols, facts, sourceRecords: sources });
    await s.saveSourceRecords(sources); await s.saveFacts(facts); await s.saveCapsule(capsule);
    capsuleIds[recipe] = capsule.id;
  };
  const b = rec("blend"), a = rec("aquarius"), d = rec("stellar_dex");
  const aid = "aqua_route:USDC:XLM:1000000000", rid = "sdex_route:USDC:XLM";
  return Promise.all([
    save(["blend"], [
      buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [b] }),
      buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [b] }),
      buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [b] }),
    ], [b], "blend-utilization-policy"),
    save(["aquarius"], [
      buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: "100000000", sources: [a] }),
      buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: 1, sources: [a] }),
    ], [a], "aquarius-route-policy"),
    save(["stellar_dex"], [
      buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: true, sources: [d] }),
      buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: "100000000", sources: [d] }),
      buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "market", entityId: "sdex_mkt:USDC:XLM", field: "market.spread_bps", value: 5, sources: [d] }),
    ], [d], "sdex-exit-policy"),
  ]).then(() => {
    const sb = rec("blend"), sa = rec("aquarius"), sd = rec("stellar_dex");
    return save(["blend", "aquarius", "stellar_dex"], [
      buildFact({ network: "mainnet", protocol: "blend", entityType: "position", entityId: "blend_pos:C:GABC", field: "health.factor", value: "1.30", sources: [sb] }),
      buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: "100000000", sources: [sa] }),
      buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: 1, sources: [sa] }),
      buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: true, sources: [sd] }),
      buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: "100000000", sources: [sd] }),
    ], [sb, sa, sd], "composite-borrow-exit-policy");
  });
}

const intents: Record<string, () => ComputeIntent> = {
  "blend-utilization-policy": () => ({ name: "blend-utilization-policy", context: { capsuleId: capsuleIds["blend-utilization-policy"] }, compute: RECIPES["blend-utilization-policy"], privateInputs: { maxUtilization: "0.834521" }, privateInputSchema: { maxUtilization: "fixed_1e6" }, reveal: ["safe"], hide: ["maxUtilization"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } }),
  "aquarius-route-policy": () => ({ name: "aquarius-route-policy", context: { capsuleId: capsuleIds["aquarius-route-policy"] }, compute: RECIPES["aquarius-route-policy"], privateInputs: { minOut: "12345678" }, privateInputSchema: { minOut: "u128" }, reveal: ["routeAcceptable"], hide: ["minOut"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } }),
  "sdex-exit-policy": () => ({ name: "sdex-exit-policy", context: { capsuleId: capsuleIds["sdex-exit-policy"] }, compute: RECIPES["sdex-exit-policy"], privateInputs: { minReceive: "12345678", maxSpreadBps: "7654321" }, privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" }, reveal: ["exitOk"], hide: ["minReceive", "maxSpreadBps"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } }),
  "composite-borrow-exit-policy": () => ({ name: "composite-borrow-exit-policy", context: { capsuleId: capsuleIds["composite-borrow-exit-policy"] }, compute: RECIPES["composite-borrow-exit-policy"], privateInputs: { minHealth: "1.234567", minReceive: "918273645" }, privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" }, reveal: ["allowed"], hide: ["minHealth", "minReceive"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } }),
};

const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path: string) => fetch(base + path).then((r) => r.json());

before(async () => {
  if (!READY) return;
  store = new MemoryStore();
  await seedAll(store);
  const sefi = new SefiClient({ network: "mainnet" }, store);
  const app = buildApp(sefi, store, "mainnet");
  await new Promise<void>((res) => { server = app.listen(0, res); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => { server?.close(); });

for (const recipe of Object.keys(intents)) {
  test(`API: prove-bn254 -> verify-bn254-local -> card for ${recipe}`, { skip: READY ? false : "circom artifacts missing" }, async () => {
    const intent = intents[recipe]();
    const proved = await post("/v1/compute/prove-bn254", intent);
    assert.equal(proved.proofEnvelope.backend, "bn254-groth16", JSON.stringify(proved).slice(0, 200));
    assert.ok(proved.proofEnvelope.proofId, "proofId present");
    assert.ok(intent.reveal[0] in proved.proofCard.publicResult, "card reveals the recipe output");

    // No private input value may appear in the human-facing surfaces the API
    // returns (proof card, public inputs = hashes, revealed result). The
    // cryptographic proof bytes are excluded: their big decimal field values
    // contain arbitrary digit runs, not the private inputs. Distinctive private
    // values are chosen so a real leak cannot hide behind a coincidence.
    const surface = JSON.stringify({ card: proved.proofCard, publicInputs: proved.proofEnvelope.publicInputs, revealed: proved.proofEnvelope.revealed });
    for (const val of Object.values(intent.privateInputs as Record<string, string>)) {
      const numeric = val.replace(".", "");
      assert.ok(!surface.includes(val) && !surface.includes(numeric), `private input ${val} leaked in API response`);
    }

    const id = proved.proofEnvelope.proofId;
    const local = await post("/v1/proofs/verify-bn254-local", { proofId: id });
    assert.equal(local.valid, true, JSON.stringify(local.reasons));

    const card = await get(`/v1/proofs/${id}/card`);
    assert.equal(card.proofId, id);
    assert.equal(card.trustModel, "proof-of-data-used");

    // On-chain verification request shape (no verifier configured -> honest not_configured).
    const prev = process.env.SEFI_VERIFIER_CONTRACT_ID;
    delete process.env.SEFI_VERIFIER_CONTRACT_ID;
    const onchain = await post("/v1/proofs/verify-on-stellar", { proofEnvelope: proved.proofEnvelope });
    assert.equal(onchain.verificationMode, "not_configured");
    if (prev) process.env.SEFI_VERIFIER_CONTRACT_ID = prev;
  });
}

test("API: context verify endpoint returns a consistency report", { skip: READY ? false : "circom artifacts missing" }, async () => {
  const v = await get(`/v1/context/${capsuleIds["blend-utilization-policy"]}/verify`);
  assert.equal(v.capsuleId, capsuleIds["blend-utilization-policy"]);
  assert.ok("ok" in v, "verify report has an ok field");
});
