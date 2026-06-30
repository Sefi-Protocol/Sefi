/**
 * FULL end-to-end Sefi proof: the ACTUAL ComputeIntent proof verified on Soroban.
 *
 *   live/synthetic capsule → compile ComputeIntent → real Groth16 proof (snarkjs)
 *   → verify locally → deploy+init verifier with the circuit VK → verify the
 *   SAME proof on Stellar testnet → emit a stellar_verified ProofCard.
 *
 * This closes the bridge: Sefi ComputeIntent proof → Soroban verifier →
 * stellar_verified. Requires circom artifacts (pnpm circom:setup), the stellar
 * CLI, and a funded testnet identity (auto-generated + funded if absent).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { SefiClient } from "@sefi/sdk";
import { RECIPES, compileIntent, evaluateCompute } from "@sefi/compute";
import { proveComputeIntent, verifyLocal, groth16ToSoroban, groth16ArtifactsReady } from "@sefi/proofs";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";

const exec = promisify(execFile);
const rustup = `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin`;
const env = existsSync(rustup) ? { ...process.env, PATH: `${rustup}:${process.env.PATH}` } : process.env;
const sh = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 600_000, env, maxBuffer: 32 * 1024 * 1024 });

async function main() {
  if (!groth16ArtifactsReady("blend-utilization-policy")) {
    console.log("SKIP: circom artifacts missing — run `pnpm circom:setup` first.");
    return;
  }
  const identity = process.env.SEFI_TESTNET_IDENTITY ?? "sefi-testnet";
  try { await sh("stellar", ["--version"]); } catch { console.log("testnet skipped: stellar CLI not found."); return; }
  try { await sh("stellar", ["keys", "address", identity]); }
  catch { console.log(`funding ${identity}...`); await sh("stellar", ["keys", "generate", identity, "--network", "testnet", "--fund"]); }

  // 1) Build a capsule + prove the actual ComputeIntent (real Groth16).
  const src = buildSourceRecord({ network: "mainnet", protocol: "blend", sourceKind: "stellar_rpc_simulate", response: { x: 1 }, ledgerSeq: 1000, adapterName: "blend", adapterVersion: "1.0.0", adapterHash: "0x" + "a1".repeat(32) });
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: "700000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: "1000000000000", sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: "fresh", sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] });
  const intent: any = { name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"], privateInputs: { maxUtilization: "0.82" }, privateInputSchema: { maxUtilization: "fixed_1e6" }, reveal: ["safe"], hide: ["maxUtilization"], proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true } };
  console.log("Proving the actual Sefi ComputeIntent (bn254-groth16)...");
  const { result, compiled } = await proveComputeIntent({ intent, capsule, facts });
  const local = await verifyLocal(result.proofEnvelope, compiled);
  console.log("local verify        :", local.valid);
  console.log("publicResult        :", JSON.stringify(result.proofCard.publicResult));

  // 2) Serialize for Soroban and deploy+init a verifier with THIS circuit's VK.
  const sor = groth16ToSoroban(result.proofEnvelope.groth16 as any);
  const wasm = "contracts/noir_ultrahonk_verifier/target/wasm32v1-none/release/noir_ultrahonk_verifier.wasm";
  if (!existsSync(wasm)) { console.log("building verifier wasm..."); await sh("stellar", ["contract", "build"]).catch(() => sh("bash", ["scripts/contracts-build.sh"])); }
  const dep = await sh("stellar", ["contract", "deploy", "--wasm", wasm, "--source", identity, "--network", "testnet"]);
  const verifier = dep.stdout.trim().split("\n").pop()!.trim();
  console.log("verifier contract   :", verifier);
  await sh("stellar", ["contract", "invoke", "--id", verifier, "--source", identity, "--network", "testnet", "--send=yes", "--", "init", "--vk", JSON.stringify(sor.vk)]);

  // 3) Verify the ACTUAL compute proof on-chain via the SDK.
  const sefi = new SefiClient({ network: "testnet" });
  const r = await sefi.verify().onStellar(result.proofEnvelope, { verifierContractId: verifier, identity });
  console.log("\non-chain verification of the ACTUAL Sefi compute proof:");
  console.log("  status            :", r.status);
  console.log("  verificationMode  :", r.verificationMode);
  console.log("  backend           :", r.backend);
  console.log("  verificationTx    :", r.verificationTx ?? "(read-only)");
  if (r.verificationMode !== "stellar_verified") { console.error("\nFAIL: expected stellar_verified"); process.exit(1); }
  console.log("\n✅ Sefi ComputeIntent proof → Soroban verifier → stellar_verified");
  console.log(`export SEFI_VERIFIER_CONTRACT_ID=${verifier}`);
}
main().catch((e) => (console.error(e.stderr || e.stack || e.message), process.exit(1)));
