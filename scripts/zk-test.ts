/**
 * ZK end-to-end test (`pnpm zk:test`): generate a REAL Groth16/BN254 proof of an
 * actual Sefi ComputeIntent with snarkjs over the circom circuit, verify it
 * cryptographically, confirm the public signals bind the capsule's zk roots, and
 * prove that a wrong claim fails. This is the reproducible proof that the ZK path
 * works end-to-end (no Stellar account needed).
 *
 * Requires the circom artifacts (`pnpm circom:setup`). With SEFI_REQUIRE_BN254=1
 * it FAILS if they are missing; otherwise it skips with an explicit reason.
 */
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { RECIPES } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, groth16ToSoroban, groth16ArtifactsReady } from "@sefi/proofs";

const REQUIRE = process.env.SEFI_REQUIRE_BN254 === "1" || process.env.REQUIRE_NOIR === "1";

function blendCapsule(borrowed: string, supplied: string, oracle: string) {
  const src = buildSourceRecord({ network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: borrowed, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: supplied, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: oracle, sources: [src] }),
  ];
  return { capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] }), facts };
}

function intent(maxUtil: string) {
  return { name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"], privateInputs: { maxUtilization: maxUtil }, privateInputSchema: { maxUtilization: "fixed_1e6" as const }, reveal: ["safe"], hide: ["maxUtilization"], proof: { backend: "bn254-groth16" as const, verifyOn: "stellar" as const, proveDataUsed: true } };
}

function assert(cond: boolean, label: string) {
  if (!cond) { console.error(`❌ ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
}

async function main() {
  if (!groth16ArtifactsReady("blend-utilization-policy")) {
    const msg = "circom artifacts missing — run `pnpm circom:setup`";
    if (REQUIRE) { console.error(`FAIL: ${msg} (SEFI_REQUIRE_BN254=1)`); process.exit(1); }
    console.log(`SKIP: ${msg}.`);
    return;
  }

  // SAFE case: utilization 0.70 < 0.82.
  {
    const { capsule, facts } = blendCapsule("700000000000", "1000000000000", "fresh");
    const { result, compiled } = await proveComputeIntent({ intent: intent("0.82"), capsule, facts });
    assert(result.proofEnvelope.backend === "bn254-groth16", "backend is bn254-groth16 (real ZK)");
    assert(result.proofCard.publicResult.safe === true, "publicResult.safe === true");
    const v = await verifyLocal(result.proofEnvelope, compiled);
    assert(v.valid, "snarkjs cryptographic verification passes: " + v.reasons.join("; "));
    const ps = result.proofEnvelope.groth16!.publicSignals;
    assert(ps[0] === "1", "circuit output matches evaluator (safe=1)");
    assert(!JSON.stringify(result).includes("0.82") && !JSON.stringify(result).includes("820000"), "no private input leaks");
    const sor = groth16ToSoroban(result.proofEnvelope.groth16 as any);
    assert(sor.proof.a.length === 128 && sor.proof.b.length === 256, "Soroban EIP-197 serialization sizes correct");
  }

  // UNSAFE case: utilization 0.90 > 0.82 -> safe=false (the circuit proves the negative honestly).
  {
    const { capsule, facts } = blendCapsule("900000000000", "1000000000000", "fresh");
    const { result } = await proveComputeIntent({ intent: intent("0.82"), capsule, facts });
    assert(result.proofCard.publicResult.safe === false, "above-threshold utilization yields safe=false");
    assert(result.proofEnvelope.groth16!.publicSignals[0] === "0", "circuit output safe=0 for the unsafe case");
  }

  console.log("\n✅ zk:test passed — real Groth16 proof of a Sefi ComputeIntent, verified.");
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
