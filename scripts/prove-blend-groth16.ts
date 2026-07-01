/**
 * Prove the blend-utilization-policy with the REAL bn254-groth16 backend over a
 * deterministic fixture capsule (`pnpm prove:blend:bn254`).
 *
 *   context capsule -> ComputeIntent -> real Groth16 proof -> verify locally.
 *
 * Requires the circom artifacts (pnpm circom:setup). With SEFI_REQUIRE_BN254=1
 * it FAILS if they are missing; it never silently falls back to another backend.
 */
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { RECIPES } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, groth16ArtifactsReady } from "@sefi/proofs";

const REQUIRE = process.env.SEFI_REQUIRE_BN254 === "1";
const PRIVATE = { maxUtilization: "0.82" };

async function main() {
  if (!groth16ArtifactsReady("blend-utilization-policy")) {
    const msg = "blend_utilization circom artifacts missing — run `pnpm circom:setup`.";
    if (REQUIRE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`); process.exit(1); }
    console.log(`SKIP: ${msg}`); return;
  }

  const src = buildSourceRecord({ network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] });

  const intent: any = {
    name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"],
    privateInputs: PRIVATE, privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"], hide: ["maxUtilization"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  };
  const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
  const v = await verifyLocal(result.proofEnvelope, compiled);

  console.log("recipe        : blend-utilization-policy");
  console.log("backend       :", result.proofEnvelope.backend);
  console.log("proofId       :", result.proofEnvelope.proofId);
  console.log("publicResult  :", JSON.stringify(result.proofCard.publicResult));
  console.log("zkFactsRoot   :", result.proofEnvelope.publicInputs.zkFactsRoot);
  console.log("zkContextRoot :", result.proofEnvelope.publicInputs.zkContextRoot);
  console.log("verifyLocal   :", v.valid, v.reasons.join("; "));

  if (result.proofEnvelope.backend !== "bn254-groth16") { console.error("FAIL: not a bn254-groth16 proof"); process.exit(1); }
  if (!v.valid) { console.error("FAIL: local verification failed"); process.exit(1); }
  const surface = JSON.stringify({ card: result.proofCard, revealed: result.proofEnvelope.revealed });
  for (const val of Object.values(PRIVATE)) {
    if (surface.includes(val)) { console.error(`FAIL: private input ${val} leaked into output`); process.exit(1); }
  }
  console.log("privateLeak   : none");
  console.log("\n✅ blend-utilization-policy proved + verified locally (bn254-groth16).");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
