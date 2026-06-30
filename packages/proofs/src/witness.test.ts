import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { RECIPES, compileIntent, evaluateCompute } from "@sefi/compute";
import { buildCapsule } from "@sefi/context-capsules";
import { buildWitness, witnessToToml, referenceEvaluate, recipeSpec } from "./witness.js";

const BLEND = "0x" + "a1".repeat(32);
const AQUA = "0x" + "b2".repeat(32);
const SDEX = "0x" + "c3".repeat(32);

function mkSource(protocol: any, adapterHash: string) {
  return buildSourceRecord({
    network: "mainnet", protocol, sourceKind: "stellar_rpc_simulate",
    response: { x: 1 }, ledgerSeq: 1000, adapterName: protocol, adapterVersion: "1.0.0", adapterHash,
  });
}
function f(protocol: any, entityType: any, entityId: string, field: string, value: unknown, src: any): SemanticFact {
  return buildFact({ network: "mainnet", protocol, entityType, entityId, field, value, sources: [src] });
}

function blendCapsule(borrowed: string, supplied: string, oracle: string) {
  const src = mkSource("blend", BLEND);
  const facts = [
    f("blend", "reserve", "blend_pool:C:USDC", "reserve.totalBorrowed", borrowed, src),
    f("blend", "reserve", "blend_pool:C:USDC", "reserve.totalSupplied", supplied, src),
    f("blend", "oracle", "oracle:C", "oracle.freshness", oracle, src),
    // an extra unrelated fact so the tree has >3 leaves (different positions)
    f("blend", "pool", "blend_pool:C", "pool.status", "active", src),
  ];
  return { capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] }), facts };
}

function blendIntent(): ComputeIntent {
  return {
    name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"],
    privateInputs: { maxUtilization: "0.82" }, privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"], hide: ["maxUtilization"],
    proof: { backend: "bn254-noir", verifyOn: "offchain", proveDataUsed: true },
  };
}

function buildBlendWitness(borrowed: string, supplied: string, oracle: string, maxUtil = "0.82") {
  const { capsule, facts } = blendCapsule(borrowed, supplied, oracle);
  const intent = { ...blendIntent(), privateInputs: { maxUtilization: maxUtil } };
  const compiled = compileIntent({ intent, capsule, facts });
  const evaluation = evaluateCompute(compiled, intent.privateInputs, facts);
  const witness = buildWitness({ recipe: intent.name, compiled, capsule, facts, evaluation, privateInputs: intent.privateInputs });
  return { witness, evaluation, capsule };
}

test("witness includes EVERY circuit input the blend circuit needs", () => {
  const { witness } = buildBlendWitness("700000000000", "1000000000000", "fresh");
  const toml = witnessToToml(witness);
  // public inputs
  for (const k of ["zk_context_root_pub", "zk_facts_root", "compute_hash", "result_hash", "source_root", "adapter_set_hash"]) {
    assert.match(toml, new RegExp(`^${k} = `, "m"), `missing public ${k}`);
  }
  // every fact slot's full input set
  for (const slot of ["borrowed", "supplied", "oracle"]) {
    for (const suffix of ["", "_path_id", "_adapter", "_ledger", "_path", "_bits"]) {
      assert.match(toml, new RegExp(`^${slot}${suffix} = `, "m"), `missing ${slot}${suffix}`);
    }
  }
  // private threshold
  assert.match(toml, /^max_utilization = /m);
  // Merkle path + bits are full depth-8 arrays.
  for (const fw of witness.facts) {
    assert.equal(fw.siblings.length, 8);
    assert.equal(fw.bits.length, 8);
  }
});

test("reference circuit accepts a valid witness and matches the evaluator (safe=true)", () => {
  const { witness, evaluation } = buildBlendWitness("700000000000", "1000000000000", "fresh");
  const ref = referenceEvaluate("blend-utilization-policy", witness.facts, witness.thresholds, {
    zkContextRoot: witness.public.zkContextRoot, zkFactsRoot: witness.public.zkFactsRoot,
    sourceRoot: witness.public.sourceRoot, adapterSetHash: witness.public.adapterSetHash,
  });
  assert.equal(ref.contextRootOk, true, "zkContextRoot recomputes");
  assert.equal(ref.merkleOk, true, "all fact Merkle paths verify against zkFactsRoot");
  assert.equal(ref.result, true);
  assert.equal(ref.result, evaluation.revealed.safe, "circuit result matches off-chain evaluator");
});

test("reference circuit returns false when utilization exceeds threshold", () => {
  const { witness, evaluation } = buildBlendWitness("900000000000", "1000000000000", "fresh");
  const ref = referenceEvaluate("blend-utilization-policy", witness.facts, witness.thresholds, witness.public);
  assert.equal(ref.merkleOk, true);
  assert.equal(ref.result, false);
  assert.equal(evaluation.revealed.safe, false);
});

test("reference circuit rejects a tampered fact value (Merkle path no longer matches)", () => {
  const { witness } = buildBlendWitness("700000000000", "1000000000000", "fresh");
  const tampered = witness.facts.map((fw) => (fw.slot === "borrowed" ? { ...fw, value: fw.value + 1n } : fw));
  const ref = referenceEvaluate("blend-utilization-policy", tampered, witness.thresholds, witness.public);
  assert.equal(ref.merkleOk, false, "tampered value breaks Merkle inclusion");
  assert.equal(ref.result, false);
});

test("reference circuit rejects a tampered zkContextRoot", () => {
  const { witness } = buildBlendWitness("700000000000", "1000000000000", "fresh");
  const ref = referenceEvaluate("blend-utilization-policy", witness.facts, witness.thresholds, {
    ...witness.public, zkContextRoot: witness.public.zkContextRoot + 1n,
  });
  assert.equal(ref.contextRootOk, false);
  assert.equal(ref.result, false);
});

function compositeWitness(health: string, aquaOut: string, hops: number, avail: boolean, sdexOut: string) {
  const bs = mkSource("blend", BLEND), as = mkSource("aquarius", AQUA), ss = mkSource("stellar_dex", SDEX);
  const facts = [
    f("blend", "position", "blend_position:C:G", "health.factor", health, bs),
    f("aquarius", "route", "aqua_route:USDC:XLM:1", "slippage.estimated_out", aquaOut, as),
    f("aquarius", "route", "aqua_route:USDC:XLM:1", "route.hops", hops, as),
    f("stellar_dex", "route", "path:USDC:XLM:1", "path.available", avail, ss),
    f("stellar_dex", "route", "path:USDC:XLM:1", "path.estimated_out", sdexOut, ss),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend", "aquarius", "stellar_dex"], facts, sourceRecords: [bs, as, ss] });
  const intent: ComputeIntent = {
    name: "composite-borrow-exit-policy", context: {}, compute: RECIPES["composite-borrow-exit-policy"],
    privateInputs: { minHealth: "1.25", minReceive: "1" }, privateInputSchema: { minHealth: "fixed_1e6" },
    reveal: ["allowed"], hide: ["minHealth", "minReceive"],
    proof: { backend: "bn254-noir", verifyOn: "offchain", proveDataUsed: true },
  };
  const compiled = compileIntent({ intent, capsule, facts });
  const evaluation = evaluateCompute(compiled, intent.privateInputs, facts);
  const witness = buildWitness({ recipe: intent.name, compiled, capsule, facts, evaluation, privateInputs: intent.privateInputs });
  return { witness, evaluation };
}

test("composite witness binds 5 facts and the reference matches the evaluator", () => {
  const { witness, evaluation } = compositeWitness("1.42", "99000000", 2, true, "98000000");
  assert.equal(witness.facts.length, 5);
  const ref = referenceEvaluate("composite-borrow-exit-policy", witness.facts, witness.thresholds, witness.public);
  assert.equal(ref.merkleOk, true);
  assert.equal(ref.contextRootOk, true);
  assert.equal(ref.result, evaluation.revealed.allowed);
  assert.equal(ref.result, true);
});

test("all four recipes have a witness spec", () => {
  for (const r of ["blend-utilization-policy", "aquarius-route-policy", "sdex-exit-policy", "composite-borrow-exit-policy"]) {
    assert.ok(recipeSpec(r));
  }
});
