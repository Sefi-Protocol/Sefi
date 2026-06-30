/** Prove the flagship composite borrow-exit policy over live mainnet (spec §10.4). */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { createStore } from "@sefi/store";

const POOL =
  process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET; // optional; health fact needs a wallet
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

async function main() {
  const sefi = new SefiClient({ network: "mainnet" }, createStore());
  if (!WALLET) {
    console.log(
      "note: SEFI_DEMO_WALLET unset — composite policy needs a Blend position (health.factor).",
    );
    console.log("Set SEFI_DEMO_WALLET=G... to prove the full composite-borrow-exit policy.");
  }
  const { proofEnvelope, proofCard } = await sefi.compute().prove({
    name: "composite-borrow-exit-policy",
    context: {
      blend: { poolId: POOL, wallet: WALLET, include: ["reserves", "oracle", "positions"] },
      aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
      sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
    },
    compute: RECIPES["composite-borrow-exit-policy"],
    privateInputs: { minHealth: "1.25", minReceive: "1" },
    reveal: ["allowed"],
    hide: ["minHealth", "minReceive"],
    proof: { backend: "prebuilt", verifyOn: "offchain", proveDataUsed: true },
  });
  console.log("proofId      :", proofEnvelope.proofId);
  console.log("backend      :", proofEnvelope.backend);
  console.log("publicResult :", JSON.stringify(proofCard.publicResult));
  console.log("contextRoot  :", proofEnvelope.publicInputs.contextRoot);
  console.log("trustModel   :", proofCard.trustModel);
  console.log(
    "Composite borrow-exit policy:",
    proofCard.publicResult.allowed ? "ALLOWED" : "NOT ALLOWED",
  );
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
