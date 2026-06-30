/**
 * Real on-chain BN254 Groth16 verification on Stellar testnet (audit follow-up
 * #3, #4). Generates a genuine Groth16 proof (ark-groth16, the same BN254 curve
 * backend Soroban's host uses), deploys/initialises the verifier contract, and
 * invokes `verify_proof` on testnet — asserting a valid proof returns TRUE and a
 * wrong public input returns FALSE. This is genuine `stellar_verified`, not a
 * commitment.
 *
 * Requires: rustup toolchain, the `stellar` CLI, and a funded testnet identity
 * (SEFI_TESTNET_IDENTITY, default `sefi-testnet`; auto-generated + funded if
 * absent). Skips with an explicit message if the toolchain is unavailable.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const exec = promisify(execFile);
const VERIFIER_DIR = "contracts/noir_ultrahonk_verifier";
const WASM = `${VERIFIER_DIR}/target/wasm32v1-none/release/noir_ultrahonk_verifier.wasm`;
const VECTOR = "/tmp/sefi-groth16-vector.json";

function rustupEnv(): NodeJS.ProcessEnv {
  // Prefer the rustup toolchain (1.91+ for soroban-sdk 25.3 + wasm target).
  const tc = `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin`;
  return existsSync(tc) ? { ...process.env, PATH: `${tc}:${process.env.PATH}` } : process.env;
}

async function sh(cmd: string, args: string[], opts: any = {}) {
  return exec(cmd, args, { timeout: 600_000, env: rustupEnv(), maxBuffer: 32 * 1024 * 1024, ...opts });
}

async function main() {
  const identity = process.env.SEFI_TESTNET_IDENTITY ?? "sefi-testnet";
  try {
    await sh("stellar", ["--version"]);
  } catch {
    console.log("testnet skipped: stellar CLI not found.");
    return;
  }
  // Ensure a funded identity.
  try {
    await sh("stellar", ["keys", "address", identity]);
  } catch {
    console.log(`Generating + funding testnet key '${identity}'...`);
    await sh("stellar", ["keys", "generate", identity, "--network", "testnet", "--fund"]);
  }

  // 1) Generate a real Groth16 vector (VK + proof + public inputs).
  console.log("Generating real Groth16/BN254 vector (ark-groth16)...");
  const { stdout: vec } = await sh("cargo", ["run", "--example", "gen_vector", "--release"], { cwd: VERIFIER_DIR });
  await writeFile(VECTOR, vec.trim());
  const v = JSON.parse(vec.trim());

  // 2) Build + deploy the verifier.
  console.log("Building + deploying verifier to testnet...");
  await sh("stellar", ["contract", "build"], { cwd: VERIFIER_DIR });
  const { stdout: dep } = await sh("stellar", [
    "contract", "deploy", "--wasm", join(VERIFIER_DIR, "target/wasm32v1-none/release/noir_ultrahonk_verifier.wasm").replace(VERIFIER_DIR + "/", VERIFIER_DIR + "/"),
    "--source", identity, "--network", "testnet",
  ]);
  const verifierId = dep.trim().split("\n").pop()!.trim();
  console.log("VERIFIER_CONTRACT_ID =", verifierId);

  // 3) init with the real VK.
  const vk = JSON.stringify({ alpha_g1: v.alpha_g1, beta_g2: v.beta_g2, gamma_g2: v.gamma_g2, delta_g2: v.delta_g2, ic: v.ic });
  await sh("stellar", ["contract", "invoke", "--id", verifierId, "--source", identity, "--network", "testnet", "--send=yes", "--", "init", "--vk", vk]);

  // 4) verify_proof: valid -> true, wrong -> false.
  const proof = JSON.stringify({ a: v.proof_a, b: v.proof_b, c: v.proof_c });
  const okRun = await sh("stellar", ["contract", "invoke", "--id", verifierId, "--source", identity, "--network", "testnet", "--send=yes", "--", "verify_proof", "--public_inputs", JSON.stringify(v.pub), "--proof", proof]);
  const verifiedTrue = okRun.stdout.trim().endsWith("true");
  const txHash = /Signing transaction: ([0-9a-f]{64})/.exec(okRun.stderr)?.[1];

  const badRun = await sh("stellar", ["contract", "invoke", "--id", verifierId, "--source", identity, "--network", "testnet", "--", "verify_proof", "--public_inputs", JSON.stringify(v.pub_wrong), "--proof", proof]);
  const verifiedFalse = badRun.stdout.trim().endsWith("false");

  console.log("\nRESULT (real on-chain BN254 verification):");
  console.log("  valid proof  -> verify_proof:", verifiedTrue ? "true" : okRun.stdout.trim());
  console.log("  wrong input  -> verify_proof:", verifiedFalse ? "false" : badRun.stdout.trim());
  console.log("  verificationTx:", txHash ?? "(read-only)");
  console.log("  verificationMode:", verifiedTrue ? "stellar_verified" : "rejected");
  if (!verifiedTrue || !verifiedFalse) {
    console.error("\nFAIL: expected valid=true and wrong=false");
    process.exit(1);
  }
  console.log("\n✅ stellar_verified: a real BN254 Groth16 proof verified on Stellar testnet.");
  console.log(`export SEFI_VERIFIER_CONTRACT_ID=${verifierId}`);
}

main().catch((e) => (console.error(e.stderr || e.stack || e.message), process.exit(1)));
