import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ProofEnvelope } from "@sefi/shared-types";
import { MemoryStore } from "./memory.js";
import { PgStore } from "./pg.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function envelope(): ProofEnvelope {
  return {
    proofId: "proof_g16_1",
    proofType: "compute_intent",
    backend: "bn254-groth16",
    publicInputs: {
      contextRoot: "0x" + "11".repeat(32) as `0x${string}`,
      sourceRoot: "0x" + "22".repeat(32) as `0x${string}`,
      semanticFactsRoot: "0x" + "33".repeat(32) as `0x${string}`,
      adapterSetHash: "0x" + "44".repeat(32) as `0x${string}`,
      computeHash: "0x" + "55".repeat(32) as `0x${string}`,
      resultHash: "0x" + "66".repeat(32) as `0x${string}`,
      zkFactsRoot: "0x" + "77".repeat(32) as `0x${string}`,
      zkContextRoot: "0x" + "88".repeat(32) as `0x${string}`,
    },
    revealed: { safe: true },
    proofBytes: "eyJ4IjoxfQ==",
    groth16: { proof: { pi_a: ["1", "2", "1"] }, publicSignals: ["1", "10", "20", "30", "40"], vkey: { protocol: "groth16", IC: [] } },
    status: "verified",
    createdAt: "2026-06-30T00:00:00Z",
  };
}

test("memory store preserves groth16 artifacts on roundtrip", async () => {
  const store = new MemoryStore();
  await store.saveProofEnvelope(envelope(), "intent_1");
  const back = await store.getProofEnvelope("proof_g16_1");
  assert.ok(back?.groth16, "groth16 present after reload");
  assert.deepEqual(back!.groth16!.publicSignals, ["1", "10", "20", "30", "40"]);
});

test("postgres store preserves groth16 artifacts (durable stellar_verified) — skips without DATABASE_URL", async (t) => {
  const url = process.env.DATABASE_URL;
  if (!url) { t.skip("DATABASE_URL not set"); return; }
  const store = new PgStore(url);
  for (const m of ["0001_init.sql", "0002_compute_proofs.sql", "0005_proof_groth16.sql"]) {
    const sql = readFileSync(resolve(__dirname, `../../../services/postgres/migrations/${m}`), "utf8");
    await (store as any).pool.query(sql);
  }
  await store.saveProofEnvelope(envelope(), undefined);
  const back = await store.getProofEnvelope("proof_g16_1");
  assert.ok(back?.groth16, "groth16 persisted + restored from Postgres");
  assert.deepEqual(back!.groth16!.publicSignals, ["1", "10", "20", "30", "40"]);
  assert.equal(back!.backend, "bn254-groth16");
  await store.close?.();
});
