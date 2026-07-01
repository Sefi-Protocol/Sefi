/**
 * Deploy ONE Groth16 verifier contract per Phase 3 circuit to Stellar testnet
 * and initialise each with its circuit's verification key (`pnpm deploy:phase3:testnet`).
 *
 * Architecture: Blend, Aquarius, SDEX and Composite circuits have DIFFERENT
 * verification keys, so each needs its own verifier contract initialised with the
 * matching VK. A verifier initialised with the Blend VK cannot verify an Aquarius
 * or Composite proof.
 *
 * Writes deployments/phase3-testnet.json:
 *   { network, deployer, recipes: { <recipe>: { circuit, verifierContractId,
 *     verificationKeyHash, deployTx } } }
 *
 * Requires: the circom vkeys (pnpm circom:setup), the `stellar` CLI, and a funded
 * testnet identity (SEFI_TESTNET_IDENTITY, default `sefi-testnet`; auto-funded).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { groth16ArtifactPaths, groth16VkToSoroban } from "@sefi/proofs";
import { sha256Hex, stableStringify } from "@sefi/source-records";

const exec = promisify(execFile);
const rustup = `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin/bin`;
const env = existsSync(rustup) ? { ...process.env, PATH: `${rustup}:${process.env.PATH}` } : process.env;
const sh = (cmd: string, args: string[]) => exec(cmd, args, { timeout: 600_000, env, maxBuffer: 32 * 1024 * 1024 });

const RECIPE_CIRCUIT: Record<string, string> = {
  "blend-utilization-policy": "blend_utilization",
  "aquarius-route-policy": "aquarius_route",
  "sdex-exit-policy": "sdex_exit",
  "composite-borrow-exit-policy": "composite_borrow_exit",
};

const WASM = "contracts/noir_ultrahonk_verifier/target/wasm32v1-none/release/noir_ultrahonk_verifier.wasm";

async function main() {
  const network = process.env.SEFI_NETWORK ?? "testnet";
  const identity = process.env.SEFI_TESTNET_IDENTITY ?? "sefi-testnet";

  // Preflight: every circuit must have a committed vkey.
  for (const [recipe, circuit] of Object.entries(RECIPE_CIRCUIT)) {
    const a = groth16ArtifactPaths(recipe);
    if (!existsSync(a.vkey)) {
      console.error(`FAIL: vkey for ${circuit} missing (${a.vkey}). Run \`pnpm circom:setup\` first.`);
      process.exit(1);
    }
  }

  try { await sh("stellar", ["--version"]); }
  catch { console.error("FAIL: stellar CLI not found."); process.exit(1); }

  // Funded identity.
  let deployer: string;
  try { deployer = (await sh("stellar", ["keys", "address", identity])).stdout.trim(); }
  catch {
    console.log(`funding testnet identity ${identity}...`);
    await sh("stellar", ["keys", "generate", identity, "--network", network, "--fund"]);
    deployer = (await sh("stellar", ["keys", "address", identity])).stdout.trim();
  }
  console.log("deployer:", deployer);

  // Build the verifier wasm once.
  if (!existsSync(WASM)) {
    console.log("building verifier wasm...");
    await sh("stellar", ["contract", "build"]).catch(() => sh("bash", ["scripts/contracts-build.sh"]));
  }

  const recipes: Record<string, unknown> = {};
  for (const [recipe, circuit] of Object.entries(RECIPE_CIRCUIT)) {
    console.log(`\n== ${recipe} (${circuit}) ==`);
    const a = groth16ArtifactPaths(recipe);
    const vkey = JSON.parse(await readFile(a.vkey, "utf8"));
    const vk = groth16VkToSoroban(vkey);
    const verificationKeyHash = sha256Hex(stableStringify(vk));

    // Deploy a dedicated verifier for this circuit.
    const dep = await sh("stellar", ["contract", "deploy", "--wasm", WASM, "--source", identity, "--network", network]);
    const verifierContractId = dep.stdout.trim().split("\n").pop()!.trim();
    const deployTx = /Signing transaction: ([0-9a-f]{64})/.exec(dep.stderr)?.[1];
    console.log("  verifier:", verifierContractId);

    // Initialise it with THIS circuit's VK.
    await sh("stellar", ["contract", "invoke", "--id", verifierContractId, "--source", identity, "--network", network, "--send=yes", "--", "init", "--vk", JSON.stringify(vk)]);
    console.log("  initialised with vkHash:", verificationKeyHash.slice(0, 18), "…");

    recipes[recipe] = { circuit, verifierContractId, verificationKeyHash, deployTx: deployTx ?? null };
  }

  const out = { network, deployer, recipes };
  await mkdir("deployments", { recursive: true });
  await writeFile("deployments/phase3-testnet.json", JSON.stringify(out, null, 2) + "\n");
  console.log("\n✅ wrote deployments/phase3-testnet.json");
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => (console.error(e.stderr || e.stack || e.message), process.exit(1)));
