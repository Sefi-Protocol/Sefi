import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import express from "express";
import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore, runMigrations } from "@sefi/store";
import { verifyCapsule } from "@sefi/context-capsules";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;

async function bootstrap() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    for (const file of [
      "0001_init.sql",
      "0002_compute_proofs.sql",
      "0003_capsule_v2_roots.sql",
      "0004_ingestion_checkpoints.sql",
    ]) {
      const sql = readFileSync(
        resolve(__dirname, `../../../services/postgres/migrations/${file}`),
        "utf8",
      );
      await runMigrations(databaseUrl, sql);
    }
    // eslint-disable-next-line no-console
    console.log("[api] migrations applied");
  }

  const store = createStore(databaseUrl);
  const sefi = new SefiClient(
    {
      network: NETWORK,
      rpcUrl: process.env.SEFI_RPC_URL,
      horizonUrl: process.env.SEFI_HORIZON_URL,
      aquariusRouter: process.env.AQUARIUS_ROUTER,
    },
    store,
  );

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const wrap =
    (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
    async (req: express.Request, res: express.Response) => {
      try {
        const out = await fn(req, res);
        if (!res.headersSent) res.json(out);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[api] error", err);
        res.status(500).json({ error: (err as Error).message });
      }
    };

  app.get("/health", (_req, res) =>
    res.json({ ok: true, network: NETWORK, live: true }),
  );

  // ---- Blend ----
  app.post(
    "/v1/blend/context",
    wrap((req) => sefi.blend().getPoolContext(req.body)),
  );
  app.post(
    "/v1/blend/ask",
    wrap((req) =>
      sefi.blend().ask({
        question: req.body.question,
        poolId: req.body.poolId,
        wallet: req.body.wallet,
      }),
    ),
  );

  // ---- Aquarius ----
  app.post(
    "/v1/aquarius/context",
    wrap((req) =>
      req.body.route
        ? sefi.aquarius().estimateSwap(req.body.route)
        : sefi.aquarius().getPools(req.body.pools ?? req.body),
    ),
  );
  app.post(
    "/v1/aquarius/ask",
    wrap((req) => sefi.aquarius().ask(req.body)),
  );

  // ---- SDEX ----
  app.post(
    "/v1/sdex/context",
    wrap((req) =>
      req.body.path
        ? sefi.sdex().findPath(req.body.path)
        : sefi.sdex().getMarket(req.body.market ?? req.body),
    ),
  );
  app.post(
    "/v1/sdex/ask",
    wrap((req) => sefi.sdex().ask(req.body)),
  );

  // ---- composite ----
  app.post(
    "/v1/context/compose",
    wrap((req) => sefi.context().compose(req.body)),
  );
  app.post(
    "/v1/ask",
    wrap((req) =>
      sefi.ask({ question: req.body.question, context: req.body.context }),
    ),
  );

  // ---- facts ----
  app.post(
    "/v1/facts/query",
    wrap((req) => sefi.facts().query(req.body)),
  );

  // ---- Phase 2: compute / proofs (spec §16). Private inputs are never echoed.
  app.post(
    "/v1/compute/compile",
    wrap(async (req) => {
      const compiled = await sefi.compute().compile(req.body);
      return compiled; // contains no private values by construction
    }),
  );
  app.post(
    "/v1/compute/evaluate",
    wrap(async (req) => {
      const { compiled, evaluation } = await sefi.compute().evaluate(req.body);
      return {
        intentId: compiled.id,
        computeHash: compiled.computeHash,
        contextRoot: compiled.contextRoot,
        revealed: evaluation.revealed,
        resultHash: evaluation.resultHash,
      };
    }),
  );
  app.post(
    "/v1/compute/prove",
    wrap(async (req) => {
      const result = await sefi.compute().prove(req.body);
      return { proofEnvelope: result.proofEnvelope, proofCard: result.proofCard };
    }),
  );
  // BN254 proving alias (audit Part I): forces the real bn254-noir backend.
  app.post(
    "/v1/compute/prove-bn254",
    wrap(async (req) => {
      const intent = {
        ...req.body,
        proof: { ...(req.body.proof ?? {}), backend: "bn254-noir" as const },
      };
      const result = await sefi.compute().prove(intent);
      return { proofEnvelope: result.proofEnvelope, proofCard: result.proofCard };
    }),
  );
  app.get(
    "/v1/compute/intents/:id",
    wrap(async (req) => (await store.getComputeIntent(req.params.id)) ?? { error: "not found" }),
  );
  app.post(
    "/v1/proofs/verify-local",
    wrap(async (req) => {
      // Strong verification (audit Part E §4): load envelope by id if given,
      // and recompute the full intent → capsule → roots → result chain.
      const envelope = req.body.proofId
        ? await store.getProofEnvelope(req.body.proofId)
        : (req.body.proofEnvelope ?? req.body);
      if (!envelope || !(envelope as any).publicInputs)
        return { valid: false, reasons: ["proof envelope not found"] };
      return sefi.verify().local(envelope, {
        compiledIntentId: req.body.compiledIntentId,
        capsuleId: req.body.capsuleId,
        dev: req.body.dev === true,
      });
    }),
  );
  // Alias for BN254-specific strong local verification (same strong path).
  app.post(
    "/v1/proofs/verify-bn254-local",
    wrap(async (req) => {
      const envelope = req.body.proofId
        ? await store.getProofEnvelope(req.body.proofId)
        : (req.body.proofEnvelope ?? req.body);
      if (!envelope || !(envelope as any).publicInputs)
        return { valid: false, reasons: ["proof envelope not found"] };
      return sefi.verify().local(envelope, {
        compiledIntentId: req.body.compiledIntentId,
        capsuleId: req.body.capsuleId,
      });
    }),
  );
  app.post(
    "/v1/proofs/verify-on-stellar",
    wrap((req) => sefi.verify().onStellar(req.body.proofEnvelope ?? req.body)),
  );
  app.get(
    "/v1/proofs/:id",
    wrap(async (req) => (await store.getProofEnvelope(req.params.id)) ?? { error: "not found" }),
  );
  app.get(
    "/v1/proofs/:id/card",
    wrap(async (req) => (await store.getProofCard(req.params.id)) ?? { error: "not found" }),
  );

  // ---- lookups + replay ----
  app.get(
    "/v1/context/:id",
    wrap(async (req) => {
      const capsule = await store.getCapsule(req.params.id);
      if (!capsule) return { error: "not found" };
      return capsule;
    }),
  );
  app.get(
    "/v1/context/:id/verify",
    wrap(async (req) => {
      const capsule = await store.getCapsule(req.params.id);
      if (!capsule) return { error: "not found" };
      const facts = await store.getCapsuleFacts(req.params.id);
      const sources = await store.getCapsuleSourceRecords(req.params.id);
      return { capsuleId: capsule.id, ...verifyCapsule(capsule, facts, sources) };
    }),
  );
  app.get(
    "/v1/source-records/:id",
    wrap(async (req) => {
      const rec = await store.getSourceRecord(req.params.id);
      return rec ?? { error: "not found" };
    }),
  );

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[api] Sefi API listening on :${PORT} (network=${NETWORK}, live)`);
  });
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
