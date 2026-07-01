/**
 * Prove the sdex-exit-policy with the REAL bn254-groth16 backend over a
 * deterministic fixture capsule (`pnpm prove:sdex:bn254`).
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
const PRIVATE = { minReceive: "99000000", maxSpreadBps: "50" };

async function main() {
  if (!groth16ArtifactsReady("sdex-exit-policy")) {
    const msg = "sdex_exit circom artifacts missing — run `pnpm circom:setup`.";
    if (REQUIRE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`); process.exit(1); }
    console.log(`SKIP: ${msg}`); return;
  }

  const src = buildSourceRecord({ network: "mainnet", protocol: "stellar_dex", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "sdex", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const routeId = "sdex_route:USDC:XLM", mktId = "sdex_mkt:USDC:XLM";
  const facts = [
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: routeId, field: "path.available", value: true, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: routeId, field: "path.estimated_out", value: "100000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "market", entityId: mktId, field: "market.spread_bps", value: 5, sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["stellar_dex"], facts, sourceRecords: [src] });

  const intent: any = {
    name: "sdex-exit-policy", context: {}, compute: RECIPES["sdex-exit-policy"],
    privateInputs: PRIVATE, privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" },
    reveal: ["exitOk"], hide: ["minReceive", "maxSpreadBps"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  };
  const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
  const v = await verifyLocal(result.proofEnvelope, compiled);

  console.log("recipe        : sdex-exit-policy");
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
  console.log("\n✅ sdex-exit-policy proved + verified locally (bn254-groth16).");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
