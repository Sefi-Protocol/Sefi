import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact, SourceRecord } from "@sefi/shared-types";
import { hashSemanticFact } from "@sefi/source-records";
import { buildCapsule, semanticFactsRoot, factMerkleProof } from "./index.js";
import { verifyMerkleProof } from "@sefi/source-records";

function src(id: string, hash: string): SourceRecord {
  return {
    id,
    network: "mainnet",
    protocol: "blend",
    sourceKind: "stellar_rpc_ledger_entries",
    requestBodyHash: "0x00",
    responseHash: hash,
    rawResponseRef: id,
    fetchedAt: "2026-06-30T00:00:00Z",
    adapterName: "blend",
    adapterVersion: "1.0.0",
    adapterHash: "0xada",
    ledgerSeq: 100,
  };
}
function fact(id: string, value: unknown): SemanticFact {
  return {
    id,
    network: "mainnet",
    protocol: "blend",
    entityType: "reserve",
    entityId: "blend_pool:C:USDC",
    field: "reserve.totalBorrowed",
    value,
    sourceRecordIds: ["s1"],
    rawHash: "0xfixed", // deliberately constant to prove value drives v2 root
    adapterHash: "0xada",
    confidence: "high",
    createdAt: "2026-06-30T00:00:00Z",
  };
}

test("changing only a fact value changes semanticFactsRoot (spec §3 must-fail test)", () => {
  const sources = [src("s1", "0xaa")];
  const f1 = fact("f1", "100");
  const f2 = fact("f2", "200");
  const before = semanticFactsRoot([f1, f2]);

  // Same source hash, same rawHash — only the value changes.
  const f2b = fact("f2", "999");
  const after = semanticFactsRoot([f1, f2b]);

  assert.notEqual(before, after, "semanticFactsRoot must change when a value changes");
});

test("capsule carries v2 contextRoot + semanticFactsRoot", () => {
  const c = buildCapsule({
    network: "mainnet",
    protocols: ["blend"],
    facts: [fact("f1", "100"), fact("f2", "200")],
    sourceRecords: [src("s1", "0xaa")],
  });
  assert.ok(c.semanticFactsRoot?.startsWith("0x"));
  assert.ok(c.contextRoot?.startsWith("0x"));
});

test("fact Merkle proof verifies against semanticFactsRoot", () => {
  const facts = [fact("f1", "100"), fact("f2", "200"), fact("f3", "300")];
  const proof = factMerkleProof(facts, facts[1]);
  assert.ok(proof, "proof exists");
  assert.equal(proof!.root, semanticFactsRoot(facts));
  assert.equal(proof!.leaf, hashSemanticFact(facts[1]));
  assert.ok(verifyMerkleProof(proof!), "proof verifies");

  // Tampered leaf fails.
  assert.equal(verifyMerkleProof({ ...proof!, leaf: "0xdead" }), false);
});
