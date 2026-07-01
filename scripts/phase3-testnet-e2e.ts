/**
 * PHASE 3 TESTNET E2E — the final acceptance script (`pnpm phase3:testnet`).
 *
 * For all four recipes (Blend, Aquarius, SDEX, Composite):
 *   build a ContextCapsule (live when available, deterministic accepted data
 *   otherwise) → real Groth16 proof → verify locally → verify on Stellar testnet
 *   against THIS circuit's dedicated verifier → assert stellar_verified.
 * Then reload every proof envelope + card from the store, re-verify locally, and
 * assert every card is stellar_verified. Prints a summary table.
 *
 * Reads verifier contract IDs from deployments/phase3-testnet.json (run
 * `pnpm deploy:phase3:testnet` first).
 *
 * With SEFI_REQUIRE_BN254=1 SEFI_REQUIRE_LIVE=1 nothing may skip: missing
 * artifacts, missing live data, or a non-stellar_verified result all exit 1.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { SemanticFact, SourceRecord, ContextCapsule } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";

const REQUIRE_BN254 = process.env.SEFI_REQUIRE_BN254 === "1";
const REQUIRE_LIVE = process.env.SEFI_REQUIRE_LIVE === "1";
// Offline fixture mode (CI phase3-fixture-e2e): prove all recipes over
// deterministic capsules + verify locally + durable reload, WITHOUT deploying or
// verifying on-chain. No Stellar network / testnet identity required.
const NO_CHAIN = process.env.SEFI_E2E_NO_CHAIN === "1";
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";
const rec = (p: any) => buildSourceRecord({ network: "mainnet", protocol: p, sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: String(p), adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });

interface Recipe {
  recipe: string;
  reveal: string;
  privateInputs: Record<string, string>;
  privateInputSchema: Record<string, string>;
  /** Deterministic accepted capsule (always yields a true, verifiable proof). */
  fixture(): { capsule: ContextCapsule; facts: SemanticFact[]; sources: SourceRecord[] };
  /** Attempt live data; return null when unavailable. */
  live(sefi: SefiClient): Promise<{ capsuleId: string } | null>;
}

function seed(protocols: any[], facts: SemanticFact[], sources: SourceRecord[]) {
  return { capsule: buildCapsule({ network: "mainnet", protocols, facts, sourceRecords: sources }), facts, sources };
}

const RECIPES_CFG: Recipe[] = [
  {
    recipe: "blend-utilization-policy", reveal: "safe",
    privateInputs: { maxUtilization: "0.82" }, privateInputSchema: { maxUtilization: "fixed_1e6" },
    fixture() {
      const s = rec("blend");
      const facts = [
        buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [s] }),
        buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [s] }),
        buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [s] }),
      ];
      return seed(["blend"], facts, [s]);
    },
    async live(sefi) {
      const pool = process.env.SEFI_DEMO_POOL;
      if (!pool) return null;
      const ctx = await sefi.context().build({ blend: { poolId: pool, include: ["reserves", "oracle"] } });
      const ok = ctx.facts.some((f) => f.field === "reserve.totalBorrowed" && f.entityId.includes(":USDC"));
      return ok ? { capsuleId: ctx.capsule.id } : null;
    },
  },
  {
    recipe: "aquarius-route-policy", reveal: "routeAcceptable",
    privateInputs: { minOut: "1" }, privateInputSchema: { minOut: "u128" },
    fixture() {
      const s = rec("aquarius"); const id = "aqua_route:USDC:XLM:1000000000";
      const facts = [
        buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "slippage.estimated_out", value: "100000000", sources: [s] }),
        buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "route.hops", value: 1, sources: [s] }),
      ];
      return seed(["aquarius"], facts, [s]);
    },
    async live(sefi) {
      const ctx = await sefi.context().build({ aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } } });
      const ok = ctx.facts.some((f) => f.field === "slippage.estimated_out") && ctx.facts.some((f) => f.field === "route.hops");
      return ok ? { capsuleId: ctx.capsule.id } : null;
    },
  },
  {
    recipe: "sdex-exit-policy", reveal: "exitOk",
    privateInputs: { minReceive: "1", maxSpreadBps: "1000" }, privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" },
    fixture() {
      const s = rec("stellar_dex");
      const facts = [
        buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: "sdex_route:USDC:XLM", field: "path.available", value: true, sources: [s] }),
        buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: "sdex_route:USDC:XLM", field: "path.estimated_out", value: "100000000", sources: [s] }),
        buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "market", entityId: "sdex_mkt:USDC:XLM", field: "market.spread_bps", value: 5, sources: [s] }),
      ];
      return seed(["stellar_dex"], facts, [s]);
    },
    async live(sefi) {
      const ctx = await sefi.context().build({ sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT }, market: { base: "USDC", counter: "XLM" } } });
      const need = ["path.available", "path.estimated_out", "market.spread_bps"];
      return need.every((f) => ctx.facts.some((x) => x.field === f)) ? { capsuleId: ctx.capsule.id } : null;
    },
  },
  {
    recipe: "composite-borrow-exit-policy", reveal: "allowed",
    privateInputs: { minHealth: "1.25", minReceive: "1" }, privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" },
    fixture() {
      const sb = rec("blend"), sa = rec("aquarius"), sd = rec("stellar_dex");
      const aid = "aqua_route:USDC:XLM:1000000000", rid = "sdex_route:USDC:XLM";
      const facts = [
        buildFact({ network: "mainnet", protocol: "blend", entityType: "position", entityId: "blend_pos:C:GABC", field: "health.factor", value: "1.30", sources: [sb] }),
        buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: "100000000", sources: [sa] }),
        buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: 1, sources: [sa] }),
        buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: true, sources: [sd] }),
        buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: "100000000", sources: [sd] }),
      ];
      return seed(["blend", "aquarius", "stellar_dex"], facts, [sb, sa, sd]);
    },
    async live(sefi) {
      const wallet = process.env.SEFI_DEMO_WALLET, pool = process.env.SEFI_DEMO_POOL;
      if (!wallet || !pool) return null;
      const ctx = await sefi.context().build({
        blend: { poolId: pool, wallet, include: ["reserves", "oracle", "positions"] },
        aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
        sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
      });
      const need = ["health.factor", "slippage.estimated_out", "route.hops", "path.available", "path.estimated_out"];
      return need.every((f) => ctx.facts.some((x) => x.field === f)) ? { capsuleId: ctx.capsule.id } : null;
    },
  },
];

function fail(msg: string): never { console.error(`\nFAIL: ${msg}`); process.exit(1); }

async function main() {
  console.log(NO_CHAIN ? "PHASE 3 FIXTURE E2E (offline, no on-chain)\n" : "PHASE 3 TESTNET E2E\n");
  let deployment: any = { network: "testnet", recipes: {} };
  if (!NO_CHAIN) {
    if (!existsSync("deployments/phase3-testnet.json"))
      fail("deployments/phase3-testnet.json missing — run `pnpm deploy:phase3:testnet` first.");
    deployment = JSON.parse(await readFile("deployments/phase3-testnet.json", "utf8"));
  }
  const network = deployment.network ?? "testnet";

  const store = createStore();
  const mainnet = new SefiClient({ network: "mainnet", aquariusRouter: process.env.AQUARIUS_ROUTER }, store);
  const testnet = new SefiClient({ network }, store);

  const summary: Array<{ recipe: string; local: boolean; mode: string; tx?: string; data: string }> = [];
  const proofIds: Record<string, string> = {};

  for (const cfg of RECIPES_CFG) {
    console.log(`\n=== ${cfg.recipe} ===`);
    if (!groth16ArtifactsReady(cfg.recipe)) {
      const m = `${cfg.recipe} circom artifacts missing — run \`pnpm circom:setup\``;
      if (REQUIRE_BN254) fail(m);
      console.log(`SKIP: ${m}`); continue;
    }
    const dep = deployment.recipes?.[cfg.recipe];
    if (!NO_CHAIN && !dep?.verifierContractId) fail(`no verifier deployed for ${cfg.recipe} in deployments/phase3-testnet.json`);

    // 1) Build context: live when available, deterministic accepted data otherwise.
    let dataSource = "deterministic";
    let capsuleId: string;
    let live: { capsuleId: string } | null = null;
    try { if (!NO_CHAIN) live = await cfg.live(mainnet); }
    catch (e) { if (REQUIRE_LIVE) fail(`live data fetch for ${cfg.recipe} failed: ${(e as Error).message}`); }
    if (live) { capsuleId = live.capsuleId; dataSource = "live"; }
    else {
      if (REQUIRE_LIVE) fail(`no live data available for ${cfg.recipe} (SEFI_REQUIRE_LIVE=1)`);
      const f = cfg.fixture();
      await store.saveSourceRecords(f.sources);
      await store.saveFacts(f.facts);
      await store.saveCapsule(f.capsule);
      capsuleId = f.capsule.id;
      console.log("  (live data unavailable — using deterministic accepted fixture)");
    }
    console.log(`  data source   : ${dataSource}`);

    // 2) Real Groth16 proof over the stored capsule.
    const proof = await mainnet.compute().prove({
      name: cfg.recipe, context: { capsuleId }, compute: (RECIPES as any)[cfg.recipe],
      privateInputs: cfg.privateInputs, privateInputSchema: cfg.privateInputSchema as any,
      reveal: [cfg.reveal], hide: Object.keys(cfg.privateInputs),
      proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
    });
    if (proof.proofEnvelope.backend !== "bn254-groth16") fail(`${cfg.recipe} did not produce a bn254-groth16 proof`);
    proofIds[cfg.recipe] = proof.proofEnvelope.proofId;

    // 3) Local cryptographic verification.
    const local = await testnet.verify().local(proof.proofEnvelope);
    console.log("  local verify  :", local.valid, local.reasons.join("; "));
    if (!local.valid) fail(`${cfg.recipe} failed local verification`);

    // 4) On-chain verification against THIS circuit's dedicated verifier.
    if (NO_CHAIN) {
      summary.push({ recipe: cfg.recipe, local: local.valid, mode: "local_only", data: dataSource });
      continue;
    }
    const r = await testnet.verify().onStellar(proof.proofEnvelope, { verifierContractId: dep.verifierContractId, network });
    console.log("  stellar verify:", r.verificationMode, r.verificationTx ?? "");
    if (r.verificationMode !== "stellar_verified") fail(`${cfg.recipe} did not reach stellar_verified (got ${r.verificationMode})`);

    summary.push({ recipe: cfg.recipe, local: local.valid, mode: r.verificationMode, tx: r.verificationTx, data: dataSource });
  }

  // 4b) Negative control: a proof sent to the WRONG circuit's verifier (different
  //     VK) must be rejected on-chain. Confirms per-circuit verifier isolation.
  const blendId = proofIds["blend-utilization-policy"];
  const aquaVerifier = deployment.recipes?.["aquarius-route-policy"]?.verifierContractId;
  if (!NO_CHAIN && blendId && aquaVerifier) {
    console.log("\n=== negative control: wrong verifier contract ===");
    const blendEnv = await store.getProofEnvelope(blendId);
    const wrong = await testnet.verify().onStellar(blendEnv!, { verifierContractId: aquaVerifier, network });
    console.log("  blend proof vs aquarius verifier:", wrong.verificationMode);
    if (wrong.verificationMode === "stellar_verified")
      fail("a Blend proof verified against the Aquarius verifier — per-circuit isolation broken");
  }

  // 5) Durable reload: every envelope re-verifies + every card is stellar_verified.
  console.log("\n=== durable reload ===");
  for (const cfg of RECIPES_CFG) {
    const id = proofIds[cfg.recipe];
    if (!id) continue;
    const env = await store.getProofEnvelope(id);
    if (!env) fail(`envelope ${id} not found on reload`);
    const v = await testnet.verify().local(env);
    if (!v.valid) fail(`reloaded envelope ${cfg.recipe} failed local verification`);
    const card = await store.getProofCard(id);
    if (!card) fail(`reloaded card ${cfg.recipe} not found`);
    if (!NO_CHAIN && card.verificationMode !== "stellar_verified")
      fail(`reloaded card ${cfg.recipe} is not stellar_verified (got ${card.verificationMode})`);
    console.log(`  ${cfg.recipe}: reload verify=true card=${card.verificationMode}`);
  }

  // Summary table.
  console.log("\n");
  for (const s of summary) {
    console.log(`${s.recipe}:`);
    console.log(`  data source   : ${s.data}`);
    console.log(`  local verify  : ${s.local}`);
    console.log(`  stellar verify: ${s.mode}`);
    if (!NO_CHAIN) console.log(`  tx            : ${s.tx ?? "(read-only)"}`);
    console.log("");
  }
  console.log("durable reload:");
  console.log("  all envelopes verified");
  console.log(NO_CHAIN ? "  all proof cards reloaded (offchain_local)\n" : "  all proof cards stellar_verified\n");

  if (summary.length !== RECIPES_CFG.length) fail(`only ${summary.length}/${RECIPES_CFG.length} recipes completed`);
  console.log(NO_CHAIN ? "✅ PHASE 3 FIXTURE E2E COMPLETE" : "✅ PHASE 3 COMPLETE");
}
main().catch((e) => (console.error(e.stderr || e.stack || e.message), process.exit(1)));
