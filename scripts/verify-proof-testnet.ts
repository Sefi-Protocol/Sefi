/**
 * Commit a Sefi proof card on Stellar testnet via the deployed registry
 * (audit Part G testnet acceptance). Uses the `stellar` CLI for signing.
 *
 * Env:
 *   SEFI_REGISTRY_CONTRACT_ID  (required)  registry contract id
 *   SEFI_TESTNET_IDENTITY      (default sefi-testnet) stellar keys alias
 *
 * Usage: SEFI_REGISTRY_CONTRACT_ID=C... pnpm tsx scripts/verify-proof-testnet.ts <proofId>
 *
 * Honesty: this commits the proof card on-chain (emit_proof_card). Because the
 * bb-generated UltraHonk VK is not yet wired into verify_proof, the
 * verificationMode is "proof_card_commitment_only" unless the on-chain
 * verify_proof path is invoked and returns true.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStore } from "@sefi/store";

const exec = promisify(execFile);

function toBytes32(hex: string): string {
  const clean = (hex.startsWith("0x") ? hex.slice(2) : hex).padStart(64, "0");
  return clean.slice(-64);
}

async function main() {
  const proofId = process.argv[2];
  const registry = process.env.SEFI_REGISTRY_CONTRACT_ID;
  const identity = process.env.SEFI_TESTNET_IDENTITY ?? "sefi-testnet";
  if (!proofId) {
    console.error("usage: pnpm tsx scripts/verify-proof-testnet.ts <proofId>");
    process.exit(1);
  }
  if (!registry) {
    console.log("testnet skipped: set SEFI_REGISTRY_CONTRACT_ID to the deployed registry.");
    process.exit(0);
  }
  const store = createStore();
  const card = await store.getProofCard(proofId);
  if (!card) {
    console.error(`proof card ${proofId} not found in this store`);
    process.exit(1);
  }

  // Use a 32-byte proof id derived from the proofId string for the on-chain key.
  const { createHash } = await import("node:crypto");
  const onchainProofId = createHash("sha256").update(proofId).digest("hex");

  const args = [
    "contract", "invoke", "--id", registry, "--source", identity, "--network", "testnet",
    "--send=yes", "--",
    "emit_proof_card",
    "--proof_id", onchainProofId,
    "--proof_type", "blendutil",
    "--context_root", toBytes32(card.contextRoot),
    "--compute_hash", toBytes32(card.computeHash),
    "--result_hash", toBytes32(card.publicResultHash),
    "--result", card.result,
  ];
  console.log(`Committing proof card ${proofId} on testnet registry ${registry} ...`);
  const { stdout, stderr } = await exec("stellar", args, { timeout: 120_000 });
  const txHash = /Signing transaction: ([0-9a-f]{64})/.exec(stderr)?.[1];
  console.log("on-chain proofId :", onchainProofId);
  console.log("transactionHash  :", txHash ?? "(see CLI output)");
  console.log("verificationMode : proof_card_commitment_only");
  console.log("trustModel       : proof-of-data-used");
  console.log(stdout.trim());
}
main().catch((e) => (console.error(e.stderr || e.stack || e.message), process.exit(1)));
