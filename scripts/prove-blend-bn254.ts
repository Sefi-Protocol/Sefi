/**
 * Prove the Blend utilization policy with the REAL BN254-Noir backend
 * (audit follow-up #6: `pnpm prove:blend:bn254`).
 *
 * Builds the complete circuit witness and runs nargo+bb. Requires the Noir
 * toolchain; without it the bn254-noir backend throws
 * SEFI_BN254_TOOLCHAIN_MISSING (it never silently falls back).
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { createStore } from "@sefi/store";

const POOL =
  process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

async function main() {
  const sefi = new SefiClient({ network: "mainnet" }, createStore());
  try {
    const { proofEnvelope, proofCard } = await sefi.compute().prove({
      name: "blend-utilization-policy",
      context: { blend: { poolId: POOL, include: ["reserves", "oracle"] } },
      compute: RECIPES["blend-utilization-policy"],
      privateInputs: { maxUtilization: "0.82" },
      privateInputSchema: { maxUtilization: "fixed_1e6" },
      reveal: ["safe"],
      hide: ["maxUtilization"],
      proof: { backend: "bn254-noir", verifyOn: "offchain", proveDataUsed: true },
    });
    console.log("backend       :", proofEnvelope.backend);
    console.log("publicResult  :", JSON.stringify(proofCard.publicResult));
    console.log("zkFactsRoot   :", proofEnvelope.publicInputs.zkFactsRoot);
    console.log("zkContextRoot :", proofEnvelope.publicInputs.zkContextRoot);
    console.log("Blend utilization policy (BN254):", proofCard.publicResult.safe ? "SAFE" : "NOT SAFE");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("SEFI_BN254_TOOLCHAIN_MISSING")) {
      console.log("SKIP: " + msg);
      console.log("Install Noir (noirup) + Barretenberg (bbup) to generate a real BN254 proof.");
      process.exit(0);
    }
    throw e;
  }
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
