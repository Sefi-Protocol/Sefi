/**
 * Live-data composite E2E: real Blend + Aquarius + SDEX data → composite
 * ContextCapsule → real Groth16 proof (composite circuit) → verify (+ optional
 * on-chain). Needs SEFI_DEMO_WALLET for the live Blend health.factor fact.
 *
 *   SEFI_DEMO_WALLET=G... pnpm prove:composite:live
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const POOL = process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET;
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

async function main() {
  if (!groth16ArtifactsReady("composite-borrow-exit-policy")) {
    console.log("SKIP: composite circom artifacts missing — run `pnpm circom:setup`.");
    return;
  }
  if (!WALLET) {
    console.log("SKIP: composite policy needs a live Blend position — set SEFI_DEMO_WALLET=G...");
    return;
  }
  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet" }, store);

  console.log("Fetching LIVE Blend + Aquarius + SDEX data ...");
  const proof = await sefi.compute().prove({
    name: "composite-borrow-exit-policy",
    context: {
      blend: { poolId: POOL, wallet: WALLET, include: ["reserves", "oracle", "positions"] },
      aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
      sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
    },
    compute: RECIPES["composite-borrow-exit-policy"],
    privateInputs: { minHealth: "1.25", minReceive: "1" },
    privateInputSchema: { minHealth: "fixed_1e6" },
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
    const r = await testnet.verify().onStellar(proof.proofEnvelope, {
      verifierContractId: process.env.SEFI_VERIFIER_CONTRACT_ID,
    });
    console.log("on-chain     :", r.verificationMode, r.verificationTx ?? "");
  }
  console.log("\n✅ live composite data → capsule → real Groth16 proof → verified");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
