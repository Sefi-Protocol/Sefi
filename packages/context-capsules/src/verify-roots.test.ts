import { test } from "node:test";
import assert from "node:assert/strict";
import type { SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildCapsule, verifyCapsule } from "./index.js";

function src(id: string, hash: string, adapterHash = "0xada"): SourceRecord {
  return {
    id, network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_ledger_entries",
    requestBodyHash: "0x00", responseHash: hash, rawResponseRef: id,
    fetchedAt: "2026-06-30T00:00:00Z", adapterName: "blend", adapterVersion: "1.0.0",
    adapterHash, ledgerSeq: 100,
  };
}
function fact(id: string, value: unknown, adapterHash = "0xada"): SemanticFact {
  return {
    id, network: "mainnet", protocol: "blend", entityType: "reserve",
    entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value,
    sourceRecordIds: ["s1"], rawHash: "0xraw", adapterHash, confidence: "high",
    createdAt: "2026-06-30T00:00:00Z",
  };
}

test("capsule carries v2 + v3 roots and rootVersion v3", () => {
  const c = buildCapsule({ network: "mainnet", protocols: ["blend"], facts: [fact("f1", "100")], sourceRecords: [src("s1", "0xaa")] });
  assert.ok(c.semanticFactsRoot?.startsWith("0x"));
  assert.ok(c.contextRoot?.startsWith("0x"));
  assert.ok(c.zkFactsRoot?.startsWith("0x"));
  assert.ok(c.zkContextRoot?.startsWith("0x"));
  assert.equal(c.rootVersion, "v3");
});

test("verifyCapsule passes for untampered capsule and reports all roots", () => {
  const facts = [fact("f1", "100"), fact("f2", "200")];
  const sources = [src("s1", "0xaa")];
  const c = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: sources });
  const v = verifyCapsule(c, facts, sources);
  assert.ok(v.ok);
  assert.equal(v.semanticFactsRootOk, true);
  assert.equal(v.contextRootOk, true);
  assert.equal(v.zkFactsRootOk, true);
  assert.equal(v.zkContextRootOk, true);
  assert.equal(v.rootVersion, "v3");
});

test("verifyCapsule fails if a fact value is tampered", () => {
  const facts = [fact("f1", "100")];
  const sources = [src("s1", "0xaa")];
  const c = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: sources });
  const v = verifyCapsule(c, [fact("f1", "999")], sources);
  assert.equal(v.semanticFactsRootOk, false);
  assert.equal(v.zkFactsRootOk, false);
  assert.equal(v.ok, false);
});

test("verifyCapsule fails if adapterHash is tampered", () => {
  const facts = [fact("f1", "100", "0xada")];
  const sources = [src("s1", "0xaa", "0xada")];
  const c = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: sources });
  // tamper: change adapter hash on both fact + source
  const v = verifyCapsule(c, [fact("f1", "100", "0xbbb")], [src("s1", "0xaa", "0xbbb")]);
  assert.equal(v.ok, false);
});

test("old v1 capsule (no v2/v3 roots) verifies in compatibility mode", () => {
  const facts = [fact("f1", "100")];
  const sources = [src("s1", "0xaa")];
  const full = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: sources });
  // simulate a legacy row: strip v2/v3 roots
  const legacy = {
    ...full,
    semanticFactsRoot: undefined,
    contextRoot: undefined,
    zkFactsRoot: undefined,
    zkContextRoot: undefined,
    rootVersion: "v1",
  };
  const v = verifyCapsule(legacy, facts, sources);
  assert.ok(v.ok, "v1 still verifies on source/facts/composite roots");
  assert.equal(v.rootVersion, "v1");
  assert.equal(v.semanticFactsRootOk, undefined, "not checked when absent");
});
