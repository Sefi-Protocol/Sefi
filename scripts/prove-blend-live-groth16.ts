/**
 * FULL live-data E2E: real Phase-1 Blend data → adapter → SourceRecord →
 * SemanticFact → ContextCapsule → real Groth16 proof → (optional) Soroban
 * verification returning stellar_verified.
 *
 * Unlike the synthetic-fixture scripts, this fetches LIVE Blend pool state from
 * mainnet via the adapter, so it exercises the whole pipeline end to end.
 *
 *   pnpm prove:blend:live          # prove over live data, verify locally
 *   SEFI_VERIFIER_CONTRACT_ID=C... pnpm prove:blend:live   # + on-chain verify
 *
 * Requires the circom artifacts (pnpm circom:setup). Live network + a Blend pool
 * that exposes a USDC reserve.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { groth16ArtifactsReady } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const POOL =
  process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";

async function main() {
  if (!groth16ArtifactsReady("blend-utilization-policy")) {
    console.log("SKIP: circom artifacts missing — run `pnpm circom:setup`.");
    return;
  }
  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet" }, store);

  // 1) LIVE Phase-1: fetch real Blend pool context (adapter -> SourceRecord ->
  //    SemanticFact -> ContextCapsule). We compose a capsule via the SDK so the
  //    ComputeIntent proves over the SAME facts the adapter produced.
  console.log(`Fetching LIVE Blend pool ${POOL} ...`);
  const ctx = await sefi.context().build({ blend: { poolId: POOL, include: ["reserves", "oracle"] } });
  const hasUsdc = ctx.facts.some(
    (f) => f.field === "reserve.totalBorrowed" && f.entityId.includes(":USDC"),
  );
  if (!hasUsdc) {
    console.log("SKIP: live pool did not expose a USDC reserve (facts:", ctx.facts.map((f) => f.field).join(","), ")");
    return;
  }
  console.log(`  captured ${ctx.facts.length} live facts, ${ctx.sourceRecords.length} source records`);
  console.log(`  capsule ${ctx.capsule.id} zkContextRoot=${ctx.capsule.zkContextRoot?.slice(0, 18)}…`);

  // 2) Prove the ComputeIntent over the stored live capsule (real Groth16).
  const proof = await sefi.compute().prove({
    name: "blend-utilization-policy",
    context: { capsuleId: ctx.capsule.id },
    compute: RECIPES["blend-utilization-policy"],
    privateInputs: { maxUtilization: "0.82" },
    privateInputSchema: { maxUtilization: "fixed_1e6" },
    reveal: ["safe"], hide: ["maxUtilization"],
    proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
  });
  console.log("\nbackend       :", proof.proofEnvelope.backend);
  console.log("publicResult  :", JSON.stringify(proof.proofCard.publicResult));
  console.log("zkContextRoot :", proof.proofEnvelope.publicInputs.zkContextRoot?.slice(0, 18), "…");

  // 3) Local cryptographic verification.
  const v = await sefi.verify().local(proof.proofEnvelope);
  console.log("verifyLocal   :", v.valid, v.reasons.join("; "));
  if (!v.valid) process.exit(1);

  // 4) Optional on-chain verification (stellar_verified) when a verifier is set.
  if (process.env.SEFI_VERIFIER_CONTRACT_ID) {
    const testnet = new SefiClient({ network: "testnet" }, store);
    const r = await testnet.verify().onStellar(proof.proofEnvelope, {
      verifierContractId: process.env.SEFI_VERIFIER_CONTRACT_ID,
    });
    console.log("\non-chain      :", r.verificationMode, r.verificationTx ?? "");
    const card = await store.getProofCard(proof.proofEnvelope.proofId);
    console.log("proofCard mode:", card?.verificationMode);
  } else {
    console.log("\n(set SEFI_VERIFIER_CONTRACT_ID to also verify on-chain -> stellar_verified)");
  }
  console.log("\n✅ live Blend data → capsule → real Groth16 proof → verified");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
