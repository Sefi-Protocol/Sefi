/**
 * Prove the composite-borrow-exit-policy with the REAL bn254-groth16 backend
 * over a deterministic multi-protocol fixture capsule (`pnpm prove:composite:bn254`).
 *
 *   Blend + Aquarius + SDEX capsule -> ComputeIntent -> real Groth16 proof ->
 *   verify locally.
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
const PRIVATE = { minHealth: "1.25", minReceive: "99000000" };

async function main() {
  if (!groth16ArtifactsReady("composite-borrow-exit-policy")) {
    const msg = "composite_borrow_exit circom artifacts missing — run `pnpm circom:setup`.";
    if (REQUIRE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`); process.exit(1); }
    console.log(`SKIP: ${msg}`); return;
  }

  const sb = buildSourceRecord({ network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const sa = buildSourceRecord({ network: "mainnet", protocol: "aquarius", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "aquarius", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const sd = buildSourceRecord({ network: "mainnet", protocol: "stellar_dex", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "sdex", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const aid = "aqua_route:USDC:XLM:1000000000", rid = "sdex_route:USDC:XLM";
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "position", entityId: "blend_pos:C:GABC", field: "health.factor", value: "1.30", sources: [sb] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: "100000000", sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: 1, sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: true, sources: [sd] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: "100000000", sources: [sd] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend", "aquarius", "stellar_dex"], facts, sourceRecords: [sb, sa, sd] });

  const intent: any = {
    name: "composite-borrow-exit-policy", context: {}, compute: RECIPES["composite-borrow-exit-policy"],
    privateInputs: PRIVATE, privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" },
    reveal: ["allowed"], hide: ["minHealth", "minReceive"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  };
  const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
  const v = await verifyLocal(result.proofEnvelope, compiled);

  console.log("recipe        : composite-borrow-exit-policy");
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
  console.log("\n✅ composite-borrow-exit-policy proved + verified locally (bn254-groth16).");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
