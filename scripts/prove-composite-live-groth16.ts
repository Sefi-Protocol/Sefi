/**
 * Live-data composite E2E: real Blend + Aquarius + SDEX data → composite
 * ContextCapsule → real Groth16 proof (composite circuit) → verify locally →
 * (optional) Soroban verification.
 *
 *   SEFI_DEMO_WALLET=G... pnpm prove:composite:live
 *   SEFI_VERIFIER_CONTRACT_ID=C... SEFI_DEMO_WALLET=G... pnpm prove:composite:live
 *   SEFI_REQUIRE_LIVE=1 SEFI_DEMO_WALLET=G... pnpm prove:composite:live   # never skip
 *
 * The composite policy needs a live Blend health.factor (SEFI_DEMO_WALLET), a
 * live Aquarius route, and a live SDEX path. With SEFI_REQUIRE_LIVE=1 the script
 * FAILS (exit 1) with an actionable message instead of skipping.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const REQUIRE_LIVE = process.env.SEFI_REQUIRE_LIVE === "1";
const POOL = process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET;
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

function stop(msg: string): never {
  if (REQUIRE_LIVE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_LIVE=1)`); process.exit(1); }
  console.log(`SKIP: ${msg}`); process.exit(0);
}

async function main() {
  if (!groth16ArtifactsReady("composite-borrow-exit-policy"))
    stop("composite_borrow_exit circom artifacts missing — run `pnpm circom:setup`.");
  if (!WALLET)
    stop("composite policy needs a live Blend position — set SEFI_DEMO_WALLET=G...");

  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet", aquariusRouter: process.env.AQUARIUS_ROUTER }, store);

  console.log("Fetching LIVE Blend + Aquarius + SDEX data ...");
  const ctx = await sefi.context().build({
    blend: { poolId: POOL, wallet: WALLET, include: ["reserves", "oracle", "positions"] },
    aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
    sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
  });
  const need = ["health.factor", "slippage.estimated_out", "route.hops", "path.available", "path.estimated_out"];
  const missing = need.filter((f) => !ctx.facts.some((x) => x.field === f));
  if (missing.length)
    stop(`live composite context is missing facts [${missing.join(", ")}] (got: ${ctx.facts.map((f) => f.field).join(",") || "none"}). Ensure the wallet has a Blend position and the pair has an Aquarius route + SDEX path.`);

  console.log(`  captured ${ctx.facts.length} live facts, ${ctx.sourceRecords.length} source records`);
  console.log(`  capsule ${ctx.capsule.id} zkContextRoot=${ctx.capsule.zkContextRoot?.slice(0, 18)}…`);

  const proof = await sefi.compute().prove({
    name: "composite-borrow-exit-policy",
    context: { capsuleId: ctx.capsule.id },
    compute: RECIPES["composite-borrow-exit-policy"],
    privateInputs: { minHealth: process.env.SEFI_DEMO_MIN_HEALTH ?? "1.25", minReceive: process.env.SEFI_DEMO_MIN_RECEIVE ?? "1" },
    privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" },
    reveal: ["allowed"], hide: ["minHealth", "minReceive"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  });
  console.log("backend      :", proof.proofEnvelope.backend);
  console.log("publicResult :", JSON.stringify(proof.proofCard.publicResult));
  const v = await sefi.verify().local(proof.proofEnvelope);
  console.log("verifyLocal  :", v.valid, v.reasons.join("; "));
  if (!v.valid) process.exit(1);

  if (process.env.SEFI_VERIFIER_CONTRACT_ID) {
    const testnet = new SefiClient({ network: "testnet" }, store);
    const r = await testnet.verify().onStellar(proof.proofEnvelope, { verifierContractId: process.env.SEFI_VERIFIER_CONTRACT_ID });
    console.log("on-chain     :", r.verificationMode, r.verificationTx ?? "");
    const card = await store.getProofCard(proof.proofEnvelope.proofId);
    console.log("proofCard mode:", card?.verificationMode);
  }
  console.log("\n✅ live composite data → capsule → real Groth16 proof → verified");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
