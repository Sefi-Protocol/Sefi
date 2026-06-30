/**
 * Prove the composite borrow-exit policy with the REAL BN254-Noir backend
 * (audit follow-up #6: `pnpm prove:composite:bn254`). Requires the Noir
 * toolchain; without it the backend throws SEFI_BN254_TOOLCHAIN_MISSING.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { createStore } from "@sefi/store";

const POOL = process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET;
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

async function main() {
  const sefi = new SefiClient({ network: "mainnet" }, createStore());
  if (!WALLET) console.log("note: set SEFI_DEMO_WALLET=G... for the live health.factor fact.");
  try {
    const { proofEnvelope, proofCard } = await sefi.compute().prove({
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
      proof: { backend: "bn254-noir", verifyOn: "offchain", proveDataUsed: true },
    });
    console.log("backend       :", proofEnvelope.backend);
    console.log("publicResult  :", JSON.stringify(proofCard.publicResult));
    console.log("zkContextRoot :", proofEnvelope.publicInputs.zkContextRoot);
    console.log("Composite borrow-exit policy (BN254):", proofCard.publicResult.allowed ? "ALLOWED" : "NOT ALLOWED");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("SEFI_BN254_TOOLCHAIN_MISSING")) {
      console.log("SKIP: " + msg);
      process.exit(0);
    }
    throw e;
  }
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
