/**
 * Prove the aquarius-route-policy with the REAL bn254-groth16 backend over a
 * deterministic fixture capsule (`pnpm prove:aquarius:bn254`).
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
const PRIVATE = { minOut: "99000000" };

async function main() {
  if (!groth16ArtifactsReady("aquarius-route-policy")) {
    const msg = "aquarius_route circom artifacts missing — run `pnpm circom:setup`.";
    if (REQUIRE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`); process.exit(1); }
    console.log(`SKIP: ${msg}`); return;
  }

  const src = buildSourceRecord({ network: "mainnet", protocol: "aquarius", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "aquarius", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const id = "aqua_route:USDC:XLM:1000000000";
  const facts = [
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "slippage.estimated_out", value: "100000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "route.hops", value: 1, sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["aquarius"], facts, sourceRecords: [src] });

  const intent: any = {
    name: "aquarius-route-policy", context: {}, compute: RECIPES["aquarius-route-policy"],
    privateInputs: PRIVATE, privateInputSchema: { minOut: "u128" },
    reveal: ["routeAcceptable"], hide: ["minOut"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  };
  const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
  const v = await verifyLocal(result.proofEnvelope, compiled);

  console.log("recipe        : aquarius-route-policy");
  console.log("backend       :", result.proofEnvelope.backend);
  console.log("proofId       :", result.proofEnvelope.proofId);
  console.log("publicResult  :", JSON.stringify(result.proofCard.publicResult));
  console.log("zkFactsRoot   :", result.proofEnvelope.publicInputs.zkFactsRoot);
  console.log("zkContextRoot :", result.proofEnvelope.publicInputs.zkContextRoot);
  console.log("verifyLocal   :", v.valid, v.reasons.join("; "));

  if (result.proofEnvelope.backend !== "bn254-groth16") { console.error("FAIL: not a bn254-groth16 proof"); process.exit(1); }
  if (!v.valid) { console.error("FAIL: local verification failed"); process.exit(1); }
  // Prove no private input is present in any surfaced field.
  const surface = JSON.stringify({ card: result.proofCard, revealed: result.proofEnvelope.revealed });
  for (const val of Object.values(PRIVATE)) {
    if (surface.includes(val)) { console.error(`FAIL: private input ${val} leaked into output`); process.exit(1); }
  }
  console.log("privateLeak   : none");
  console.log("\n✅ aquarius-route-policy proved + verified locally (bn254-groth16).");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
