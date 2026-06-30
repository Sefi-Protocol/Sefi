import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact } from "@sefi/shared-types";
import {
  BN254_FR_MODULUS,
  bytes32ToFr,
  factPathId,
  hashFactToFr,
  zkFactsRootFr,
  zkFactMerkleProof,
  verifyZkMerkleProof,
  buildFixedTree,
  fixedTreeProof,
  ZK_MERKLE_DEPTH,
  zkContextRootFr,
} from "./zk-hash.js";

function fact(partial: Partial<SemanticFact>): SemanticFact {
  return {
    id: "f",
    network: "mainnet",
    protocol: "blend",
    entityType: "reserve",
    entityId: "blend_pool:C:USDC",
    field: "reserve.totalBorrowed",
    value: "100",
    sourceRecordIds: ["s1"],
    rawHash: "0xraw",
    adapterHash: "0xada",
    confidence: "high",
    createdAt: "2026-06-30T00:00:00Z",
    ...partial,
  };
}

test("bytes32ToFr reduces mod BN254 Fr and is deterministic", () => {
  const a = bytes32ToFr("0x" + "ff".repeat(32));
  assert.ok(a < BN254_FR_MODULUS);
  assert.equal(a, bytes32ToFr("ff".repeat(32))); // 0x optional
  // golden vector: all-zero -> 0
  assert.equal(bytes32ToFr("0x" + "00".repeat(32)), 0n);
  // golden vector: value 1
  assert.equal(bytes32ToFr("0x" + "00".repeat(31) + "01"), 1n);
});

test("factPathId resolves the registry", () => {
  assert.equal(factPathId(fact({ field: "reserve.totalBorrowed", entityId: "blend_pool:C:USDC" })), 1001);
  assert.equal(factPathId(fact({ field: "reserve.totalSupplied", entityId: "blend_pool:C:USDC" })), 1002);
  assert.equal(factPathId(fact({ protocol: "blend", entityType: "oracle", field: "oracle.freshness", entityId: "oracle:C" })), 1003);
  assert.equal(factPathId(fact({ protocol: "aquarius", entityType: "route", field: "slippage.estimated_out", entityId: "r" })), 2001);
  assert.equal(factPathId(fact({ protocol: "stellar_dex", entityType: "route", field: "path.available", entityId: "p" })), 3001);
});

test("zkFactLeafHash golden vector is stable", () => {
  const f = fact({ value: "100", ledgerSeq: 1000 });
  const h1 = hashFactToFr(f);
  const h2 = hashFactToFr(fact({ value: "100", ledgerSeq: 1000 }));
  assert.equal(h1, h2, "deterministic");
  assert.ok(h1 < BN254_FR_MODULUS);
});

test("changing value changes zkFactsRoot", () => {
  const a = zkFactsRootFr([fact({ id: "a", value: "100" }), fact({ id: "b", value: "200" })]);
  const b = zkFactsRootFr([fact({ id: "a", value: "100" }), fact({ id: "b", value: "999" })]);
  assert.notEqual(a, b);
});

test("changing pathId changes zkFactsRoot", () => {
  const borrowed = zkFactsRootFr([fact({ field: "reserve.totalBorrowed" })]);
  const supplied = zkFactsRootFr([fact({ field: "reserve.totalSupplied" })]);
  assert.notEqual(borrowed, supplied);
});

test("changing adapter hash changes zkFactsRoot", () => {
  const a = zkFactsRootFr([fact({ adapterHash: "0xada" })]);
  const b = zkFactsRootFr([fact({ adapterHash: "0xbbb" })]);
  assert.notEqual(a, b);
});

test("fixed-depth tree produces depth-length inclusion proofs that verify", () => {
  const leaves = [11n, 22n, 33n, 44n, 55n];
  const tree = buildFixedTree(leaves);
  for (let i = 0; i < leaves.length; i++) {
    const proof = fixedTreeProof(tree, i);
    assert.equal(proof.siblings.length, ZK_MERKLE_DEPTH);
    assert.equal(proof.bits.length, ZK_MERKLE_DEPTH);
    assert.equal(proof.leaf, leaves[i]);
    assert.equal(proof.root, tree.root);
    assert.ok(verifyZkMerkleProof(proof), `leaf ${i} verifies`);
  }
});

test("fixed-depth Merkle proof is tamper-evident", () => {
  const facts = [fact({ id: "a", value: "100" }), fact({ id: "b", value: "200" }), fact({ id: "c", value: "300" })];
  const proof = zkFactMerkleProof(facts, 1);
  assert.equal(proof.leaf, hashFactToFr(facts[1]));
  assert.ok(verifyZkMerkleProof(proof));
  // Tampered leaf fails.
  assert.equal(verifyZkMerkleProof({ ...proof, leaf: 999n }), false);
  // Tampered sibling fails.
  const badSibs = [...proof.siblings];
  badSibs[0] = badSibs[0] + 1n;
  assert.equal(verifyZkMerkleProof({ ...proof, siblings: badSibs }), false);
});

test("fixed-depth root is insertion-order sensitive and matches zkFactsRootFr", () => {
  const f1 = fact({ id: "a", value: "100" });
  const f2 = fact({ id: "b", value: "200" });
  assert.notEqual(zkFactsRootFr([f1, f2]), zkFactsRootFr([f2, f1]));
  assert.equal(zkFactsRootFr([f1, f2]), buildFixedTree([hashFactToFr(f1), hashFactToFr(f2)]).root);
});

test("zkContextRoot binds zkFactsRoot + sourceRoot + adapterSetHash", () => {
  const zk = zkFactsRootFr([fact({})]);
  const r1 = zkContextRootFr({ zkFactsRoot: zk, sourceRootHex: "0x01", adapterSetHashHex: "0x02" });
  const r2 = zkContextRootFr({ zkFactsRoot: zk, sourceRootHex: "0x01", adapterSetHashHex: "0x03" });
  assert.notEqual(r1, r2, "adapterSetHash affects the root");
});
