/**
 * Emit/commit a proof card on Stellar (spec §15). Phase 2 is commitment-only:
 * it records the proof card's context root + result hash via the registry's
 * emit_proof_card. It is labelled `proof_card_commitment_only` and is NOT
 * on-chain ZK verification.
 *
 *   SEFI_VERIFIER_REGISTRY_ID=C... SEFI_TESTNET_SECRET=S... pnpm tsx scripts/emit-proof-card.ts <proofId>
 */
import { createStore } from "@sefi/store";
import { VerifierRegistryClient } from "@sefi/verifier-registry-client";

async function main() {
  const proofId = process.argv[2];
  const registryId = process.env.SEFI_VERIFIER_REGISTRY_ID;
  if (!proofId) {
    console.error("usage: pnpm tsx scripts/emit-proof-card.ts <proofId>");
    process.exit(1);
  }
  const store = createStore();
  const card = await store.getProofCard(proofId);
  if (!card) {
    console.error(`proof card ${proofId} not found in this store`);
    process.exit(1);
  }
  console.log("proof card:", JSON.stringify(card, null, 2));
  if (!registryId || process.env.SEFI_STELLAR_TESTNET !== "1") {
    console.log(
      "\nVerification mode: proof_card_commitment_only (not on-chain ZK verification).",
    );
    console.log(
      "Set SEFI_STELLAR_TESTNET=1, SEFI_VERIFIER_REGISTRY_ID, and SEFI_TESTNET_SECRET to commit on testnet.",
    );
    process.exit(0);
  }
  const client = new VerifierRegistryClient(registryId, { network: "testnet" });
  console.log("mode:", JSON.stringify(client.describeMode()));
  console.log(
    "Submitting the emit_proof_card transaction requires a funded signer; wire your signing flow here.",
  );
  if (store.close) await store.close();
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
