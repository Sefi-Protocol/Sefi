/**
 * FULL live-data E2E for aquarius-route-policy: real Aquarius AMM route data via
 * the adapter → SourceRecord → SemanticFact → ContextCapsule → real Groth16
 * proof → verify locally → (optional) Soroban verification.
 *
 *   pnpm prove:aquarius:live
 *   SEFI_VERIFIER_CONTRACT_ID=C... pnpm prove:aquarius:live   # + on-chain verify
 *   SEFI_REQUIRE_LIVE=1 pnpm prove:aquarius:live              # never skip
 *
 * Requires circom artifacts (pnpm circom:setup) and a live Aquarius route for the
 * requested pair. With SEFI_REQUIRE_LIVE=1 the script FAILS (exit 1) with an
 * actionable message instead of skipping.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const REQUIRE_LIVE = process.env.SEFI_REQUIRE_LIVE === "1";
const TOKEN_IN = process.env.SEFI_DEMO_TOKEN_IN ?? "USDC";
const TOKEN_OUT = process.env.SEFI_DEMO_TOKEN_OUT ?? "XLM";
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

function stop(msg: string): never {
  if (REQUIRE_LIVE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_LIVE=1)`); process.exit(1); }
  console.log(`SKIP: ${msg}`); process.exit(0);
}

async function main() {
  if (!groth16ArtifactsReady("aquarius-route-policy"))
    stop("aquarius_route circom artifacts missing — run `pnpm circom:setup`.");

  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet", aquariusRouter: process.env.AQUARIUS_ROUTER }, store);

  console.log(`Fetching LIVE Aquarius route ${TOKEN_IN}->${TOKEN_OUT} amount=${AMOUNT} ...`);
  const ctx = await sefi.context().build({
    aquarius: { route: { tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: AMOUNT } },
  });
  const hasRoute =
    ctx.facts.some((f) => f.protocol === "aquarius" && f.field === "slippage.estimated_out") &&
    ctx.facts.some((f) => f.protocol === "aquarius" && f.field === "route.hops");
  if (!hasRoute)
    stop(`no live Aquarius route for ${TOKEN_IN}->${TOKEN_OUT} (facts: ${ctx.facts.map((f) => f.field).join(",") || "none"}). Try a liquid pair or set SEFI_DEMO_TOKEN_IN/OUT.`);

  console.log(`  captured ${ctx.facts.length} live facts, ${ctx.sourceRecords.length} source records`);
  console.log(`  capsule ${ctx.capsule.id} zkContextRoot=${ctx.capsule.zkContextRoot?.slice(0, 18)}…`);

  const proof = await sefi.compute().prove({
    name: "aquarius-route-policy",
    context: { capsuleId: ctx.capsule.id },
    compute: RECIPES["aquarius-route-policy"],
    privateInputs: { minOut: process.env.SEFI_DEMO_MIN_OUT ?? "1" },
    privateInputSchema: { minOut: "u128" },
    reveal: ["routeAcceptable"], hide: ["minOut"],
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
  console.log("\n✅ live Aquarius data → capsule → real Groth16 proof → verified");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
