/**
 * Phase 3 durable-proof roundtrip for ALL four recipes: prove -> save envelope +
 * card -> reload -> verify locally -> serialize to the Soroban format, asserting
 * the public-signal count/order and proof-card fields survive persistence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { RECIPES } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, groth16ToSoroban, groth16ArtifactsReady } from "@sefi/proofs";
import { MemoryStore } from "@sefi/store";

const ADAPTER = "0x" + "a1".repeat(32);
const rec = (protocol: any) => buildSourceRecord({ network: "mainnet", protocol, sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: String(protocol), adapterVersion: "1.0.0", adapterHash: ADAPTER });

interface Case { recipe: string; reveal: string; capsule: ReturnType<typeof buildCapsule>; facts: SemanticFact[]; intent: ComputeIntent; }

function blend(): Case {
  const s = rec("blend");
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [s] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [s] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [s] }),
  ];
  return { recipe: "blend-utilization-policy", reveal: "safe", capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [s] }), facts,
    intent: { name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"], privateInputs: { maxUtilization: "0.82" }, privateInputSchema: { maxUtilization: "fixed_1e6" }, reveal: ["safe"], hide: ["maxUtilization"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } } };
}

function aquarius(): Case {
  const s = rec("aquarius");
  const id = "aqua_route:USDC:XLM:1000000000";
  const facts = [
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "slippage.estimated_out", value: "100000000", sources: [s] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "route.hops", value: 1, sources: [s] }),
  ];
  return { recipe: "aquarius-route-policy", reveal: "routeAcceptable", capsule: buildCapsule({ network: "mainnet", protocols: ["aquarius"], facts, sourceRecords: [s] }), facts,
    intent: { name: "aquarius-route-policy", context: {}, compute: RECIPES["aquarius-route-policy"], privateInputs: { minOut: "99000000" }, privateInputSchema: { minOut: "u128" }, reveal: ["routeAcceptable"], hide: ["minOut"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } } };
}

function sdex(): Case {
  const s = rec("stellar_dex");
  const facts = [
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: "sdex_route:USDC:XLM", field: "path.available", value: true, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: "sdex_route:USDC:XLM", field: "path.estimated_out", value: "100000000", sources: [s] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "market", entityId: "sdex_mkt:USDC:XLM", field: "market.spread_bps", value: 5, sources: [s] }),
  ];
  return { recipe: "sdex-exit-policy", reveal: "exitOk", capsule: buildCapsule({ network: "mainnet", protocols: ["stellar_dex"], facts, sourceRecords: [s] }), facts,
    intent: { name: "sdex-exit-policy", context: {}, compute: RECIPES["sdex-exit-policy"], privateInputs: { minReceive: "99000000", maxSpreadBps: "50" }, privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" }, reveal: ["exitOk"], hide: ["minReceive", "maxSpreadBps"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } } };
}

function composite(): Case {
  const s = rec("blend"), sa = rec("aquarius"), sd = rec("stellar_dex");
  const aid = "aqua_route:USDC:XLM:1000000000", rid = "sdex_route:USDC:XLM";
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "position", entityId: "blend_pos:C:GABC", field: "health.factor", value: "1.30", sources: [s] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: "100000000", sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: 1, sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: true, sources: [sd] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: "100000000", sources: [sd] }),
  ];
  return { recipe: "composite-borrow-exit-policy", reveal: "allowed", capsule: buildCapsule({ network: "mainnet", protocols: ["blend", "aquarius", "stellar_dex"], facts, sourceRecords: [s, sa, sd] }), facts,
    intent: { name: "composite-borrow-exit-policy", context: {}, compute: RECIPES["composite-borrow-exit-policy"], privateInputs: { minHealth: "1.25", minReceive: "99000000" }, privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" }, reveal: ["allowed"], hide: ["minHealth", "minReceive"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } } };
}

for (const make of [blend, aquarius, sdex, composite]) {
  const c = make();
  const ready = groth16ArtifactsReady(c.recipe);
  test(`durable roundtrip: ${c.recipe} prove -> save -> reload -> verify -> serialize`, { skip: ready ? false : `${c.recipe} circom zkey not built` }, async () => {
    const store = new MemoryStore();
    const { result, compiled } = await proveComputeIntent({ intent: c.intent, capsule: c.capsule, facts: c.facts });
    await store.saveProofEnvelope(result.proofEnvelope, "intent_1");
    await store.saveProofCard(result.proofCard);

    // Reload the envelope and verify it still checks out cryptographically.
    const back = await store.getProofEnvelope(result.proofEnvelope.proofId);
    assert.ok(back?.groth16, "groth16 artifacts survive persistence");
    const v = await verifyLocal(back!, compiled);
    assert.ok(v.valid, v.reasons.join("; "));

    // Public signal count + order: [result, zkContextRoot, zkFactsRoot, computeHash, resultHash].
    const ps = back!.groth16!.publicSignals;
    assert.equal(ps.length, 5, "exactly 5 public signals");
    const toFr = (hex?: string) => (BigInt(hex!) % (BigInt("21888242871839275222246405745257275088548364400416034343698204186575808495617"))).toString(10);
    assert.equal(ps[1], toFr(back!.publicInputs.zkContextRoot), "signal[1] = zkContextRoot");
    assert.equal(ps[2], toFr(back!.publicInputs.zkFactsRoot), "signal[2] = zkFactsRoot");
    assert.equal(ps[3], toFr(back!.publicInputs.computeHash), "signal[3] = computeHash");
    assert.equal(ps[4], toFr(back!.publicInputs.resultHash), "signal[4] = resultHash");

    // Serialize to Soroban format (EIP-197 sizes + IC length).
    const sor = groth16ToSoroban(back!.groth16 as any);
    assert.equal(sor.proof.a.length, 128);
    assert.equal(sor.proof.b.length, 256);
    assert.equal(sor.proof.c.length, 128);
    assert.equal(sor.publicInputs.length, 5);
    assert.equal(sor.vk.ic.length, 6, "IC has one base point plus one per public signal");

    // Proof-card fields survive reload.
    const card = await store.getProofCard(result.proofEnvelope.proofId);
    assert.ok(card, "card reloaded");
    assert.equal(card!.proofId, result.proofEnvelope.proofId);
    assert.equal(card!.trustModel, "proof-of-data-used");
    assert.ok(c.reveal in (card!.publicResult as Record<string, unknown>), `card reveals ${c.reveal}`);
  });
}
