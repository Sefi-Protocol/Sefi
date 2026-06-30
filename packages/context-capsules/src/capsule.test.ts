import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildCapsule, composeContexts, verifyCapsule } from "./index.js";

function src(id: string, hash: string): SourceRecord {
  return {
    id,
    network: "testnet",
    protocol: "blend",
    sourceKind: "protocol_api",
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
function fact(id: string, rawHash: string): SemanticFact {
  return {
    id,
    network: "testnet",
    protocol: "blend",
    entityType: "reserve",
    entityId: "e",
    field: "pool.utilization",
    value: "0.5",
    sourceRecordIds: [],
    rawHash,
    adapterHash: "0xada",
    confidence: "high",
    createdAt: "2026-06-30T00:00:00Z",
  };
}

test("buildCapsule produces stable composite root", () => {
  const sources = [src("s1", "0xaa"), src("s2", "0xbb")];
  const facts = [fact("f1", "0xaa"), fact("f2", "0xbb")];
  const c1 = buildCapsule({ network: "testnet", protocols: ["blend"], facts, sourceRecords: sources });
  const c2 = buildCapsule({ network: "testnet", protocols: ["blend"], facts: [...facts].reverse(), sourceRecords: [...sources].reverse() });
  assert.equal(c1.compositeRoot, c2.compositeRoot, "root is order independent");
  assert.equal(c1.capsuleType, "single_protocol");
});

test("verifyCapsule round-trips", () => {
  const sources = [src("s1", "0xaa"), src("s2", "0xbb")];
  const facts = [fact("f1", "0xaa")];
  const c = buildCapsule({ network: "testnet", protocols: ["blend"], facts, sourceRecords: sources });
  const v = verifyCapsule(c, facts, sources);
  assert.ok(v.ok);
  // tamper a fact hash -> factsRoot mismatch
  const bad = verifyCapsule(c, [fact("f1", "0xZZ")], sources);
  assert.equal(bad.factsRootOk, false);
  assert.equal(bad.ok, false);
});

test("composeContexts marks multi_protocol", () => {
  const { composite, capsule } = composeContexts("testnet", [
    { protocol: "blend", network: "testnet", facts: [fact("f1", "0xaa")], sourceRecords: [src("s1", "0xaa")], warnings: [] },
    { protocol: "aquarius", network: "testnet", facts: [fact("f2", "0xbb")], sourceRecords: [src("s2", "0xbb")], warnings: [] },
  ]);
  assert.equal(capsule.capsuleType, "multi_protocol");
  assert.equal(composite.protocols.length, 2);
  assert.equal(composite.facts.length, 2);
});
