import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { SemanticFact, SourceRecord } from "@sefi/shared-types";
import { buildCapsule } from "@sefi/context-capsules";
import { MemoryStore } from "./memory.js";
import { PgStore } from "./pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function src(): SourceRecord {
  return {
    id: "s1", network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_ledger_entries",
    requestBodyHash: "0x00", responseHash: "0xaa", rawResponseRef: "s1", rawResponse: { x: 1 },
    fetchedAt: "2026-06-30T00:00:00Z", adapterName: "blend", adapterVersion: "1.0.0",
    adapterHash: "0xada", ledgerSeq: 100,
  };
}
function fact(): SemanticFact {
  return {
    id: "f1", network: "mainnet", protocol: "blend", entityType: "reserve",
    entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "100",
    sourceRecordIds: ["s1"], rawHash: "0xraw", adapterHash: "0xada", confidence: "high",
    createdAt: "2026-06-30T00:00:00Z",
  };
}

const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts: [fact()], sourceRecords: [src()] });

test("memory store preserves v2/v3 roots on roundtrip", async () => {
  const store = new MemoryStore();
  await store.saveSourceRecords([src()]);
  await store.saveFacts([fact()]);
  await store.saveCapsule(capsule);
  const back = await store.getCapsule(capsule.id);
  assert.equal(back!.semanticFactsRoot, capsule.semanticFactsRoot);
  assert.equal(back!.contextRoot, capsule.contextRoot);
  assert.equal(back!.zkFactsRoot, capsule.zkFactsRoot);
  assert.equal(back!.zkContextRoot, capsule.zkContextRoot);
  assert.equal(back!.adapterSetHash, capsule.adapterSetHash);
});

test("postgres store preserves v2/v3 roots + adapterSetHash (skips without DATABASE_URL)", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    t.skip("DATABASE_URL not set — Postgres roundtrip skipped");
    return;
  }
  const store = new PgStore(url);
  for (const m of ["0001_init.sql", "0002_compute_proofs.sql", "0003_capsule_v2_roots.sql"]) {
    const sql = readFileSync(resolve(__dirname, `../../../services/postgres/migrations/${m}`), "utf8");
    await (store as any).pool.query(sql);
  }
  await store.saveSourceRecords([src()]);
  await store.saveFacts([fact()]);
  await store.saveCapsule(capsule);
  const back = await store.getCapsule(capsule.id);
  assert.equal(back!.semanticFactsRoot, capsule.semanticFactsRoot);
  assert.equal(back!.contextRoot, capsule.contextRoot);
  assert.equal(back!.zkFactsRoot, capsule.zkFactsRoot);
  assert.equal(back!.zkContextRoot, capsule.zkContextRoot);
  assert.equal(back!.adapterSetHash, capsule.adapterSetHash);
  await store.close?.();
});
