/** Prove the Blend utilization policy over live mainnet (spec §10.1 / §24). */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { createStore } from "@sefi/store";

const POOL =
  process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

async function main() {
  const sefi = new SefiClient({ network: "mainnet" }, createStore());
  const { proofEnvelope, proofCard } = await sefi.compute().prove({
    name: "blend-utilization-policy",
    context: { blend: { poolId: POOL, include: ["reserves", "oracle"] } },
    compute: RECIPES["blend-utilization-policy"],
    privateInputs: { maxUtilization: "0.82" }, // decimal ratio, kept private
    privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"],
    hide: ["maxUtilization"],
    proof: { backend: "prebuilt", verifyOn: "offchain", proveDataUsed: true },
  });
  console.log("proofId        :", proofEnvelope.proofId);
  console.log("backend        :", proofEnvelope.backend);
  console.log("publicResult   :", JSON.stringify(proofCard.publicResult));
  console.log("contextRoot    :", proofEnvelope.publicInputs.contextRoot);
  console.log("semanticFacts  :", proofEnvelope.publicInputs.semanticFactsRoot);
  console.log("computeHash    :", proofEnvelope.publicInputs.computeHash);
  console.log("resultHash     :", proofEnvelope.publicInputs.resultHash);
  console.log("trustModel     :", proofCard.trustModel);
  console.log("Blend utilization policy:", proofCard.publicResult.safe ? "SAFE" : "NOT SAFE");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
