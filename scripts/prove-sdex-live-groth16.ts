/**
 * FULL live-data E2E for sdex-exit-policy: real Stellar DEX path + orderbook data
 * via the adapter → SourceRecord → SemanticFact → ContextCapsule → real Groth16
 * proof → verify locally → (optional) Soroban verification.
 *
 *   pnpm prove:sdex:live
 *   SEFI_VERIFIER_CONTRACT_ID=C... pnpm prove:sdex:live      # + on-chain verify
 *   SEFI_REQUIRE_LIVE=1 pnpm prove:sdex:live                 # never skip
 *
 * The sdex-exit-policy needs both the strict-send path (path.available,
 * path.estimated_out) and the orderbook spread (market.spread_bps), so the live
 * context requests both `path` and `market`. With SEFI_REQUIRE_LIVE=1 the script
 * FAILS (exit 1) with an actionable message instead of skipping.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const REQUIRE_LIVE = process.env.SEFI_REQUIRE_LIVE === "1";
const SRC_ASSET = process.env.SEFI_DEMO_TOKEN_IN ?? "USDC";
const DST_ASSET = process.env.SEFI_DEMO_TOKEN_OUT ?? "XLM";
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

function stop(msg: string): never {
  if (REQUIRE_LIVE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_LIVE=1)`); process.exit(1); }
  console.log(`SKIP: ${msg}`); process.exit(0);
}

async function main() {
  if (!groth16ArtifactsReady("sdex-exit-policy"))
    stop("sdex_exit circom artifacts missing — run `pnpm circom:setup`.");

  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet" }, store);

  console.log(`Fetching LIVE SDEX path + market ${SRC_ASSET}->${DST_ASSET} amount=${AMOUNT} ...`);
  const ctx = await sefi.context().build({
    sdex: {
      path: { sourceAsset: SRC_ASSET, destinationAsset: DST_ASSET, sourceAmount: AMOUNT },
      market: { base: SRC_ASSET, counter: DST_ASSET },
    },
  });
  const need = ["path.available", "path.estimated_out", "market.spread_bps"];
  const missing = need.filter((f) => !ctx.facts.some((x) => x.field === f));
  if (missing.length)
    stop(`live SDEX context is missing facts [${missing.join(", ")}] for ${SRC_ASSET}->${DST_ASSET} (got: ${ctx.facts.map((f) => f.field).join(",") || "none"}). Try a pair with an active orderbook.`);

  console.log(`  captured ${ctx.facts.length} live facts, ${ctx.sourceRecords.length} source records`);
  console.log(`  capsule ${ctx.capsule.id} zkContextRoot=${ctx.capsule.zkContextRoot?.slice(0, 18)}…`);

  const proof = await sefi.compute().prove({
    name: "sdex-exit-policy",
    context: { capsuleId: ctx.capsule.id },
    compute: RECIPES["sdex-exit-policy"],
    privateInputs: { minReceive: process.env.SEFI_DEMO_MIN_RECEIVE ?? "1", maxSpreadBps: process.env.SEFI_DEMO_MAX_SPREAD ?? "1000" },
    privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" },
    reveal: ["exitOk"], hide: ["minReceive", "maxSpreadBps"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  });
  console.log("backend       :", proof.proofEnvelope.backend);
  console.log("publicResult  :", JSON.stringify(proof.proofCard.publicResult));
  console.log("zkContextRoot :", proof.proofEnvelope.publicInputs.zkContextRoot?.slice(0, 18), "…");

  const v = await sefi.verify().local(proof.proofEnvelope);
  console.log("verifyLocal   :", v.valid, v.reasons.join("; "));
  if (!v.valid) process.exit(1);

  if (process.env.SEFI_VERIFIER_CONTRACT_ID) {
    const testnet = new SefiClient({ network: "testnet" }, store);
    const r = await testnet.verify().onStellar(proof.proofEnvelope, { verifierContractId: process.env.SEFI_VERIFIER_CONTRACT_ID });
    console.log("on-chain      :", r.verificationMode, r.verificationTx ?? "");
    const card = await store.getProofCard(proof.proofEnvelope.proofId);
    console.log("proofCard mode:", card?.verificationMode);
  } else {
    console.log("(set SEFI_VERIFIER_CONTRACT_ID to also verify on-chain -> stellar_verified)");
  }
  console.log("\n✅ live SDEX data → capsule → real Groth16 proof → verified");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
