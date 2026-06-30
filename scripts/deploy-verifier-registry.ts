/**
 * Deploy the Sefi Verifier Registry to Stellar testnet (spec §15). Requires the
 * Soroban toolchain + a funded key. This wrapper documents the flow and refuses
 * to run without explicit opt-in; it never spends mainnet funds.
 *
 *   SEFI_STELLAR_TESTNET=1 SEFI_TESTNET_SECRET=S... pnpm tsx scripts/deploy-verifier-registry.ts
 */
async function main() {
  if (process.env.SEFI_STELLAR_TESTNET !== "1") {
    console.log("Verifier-registry deploy is testnet-only and opt-in.");
    console.log("Set SEFI_STELLAR_TESTNET=1 and SEFI_TESTNET_SECRET=S... to enable.");
    console.log("\nBuild + deploy steps (run manually with the Soroban CLI):");
    console.log("  1. cd contracts/verifier-registry && soroban contract build");
    console.log("  2. soroban contract deploy \\");
    console.log("       --wasm target/wasm32-unknown-unknown/release/sefi_verifier_registry.wasm \\");
    console.log("       --source $SEFI_TESTNET_SECRET --network testnet");
    console.log("  3. export SEFI_VERIFIER_REGISTRY_ID=<deployed contract id>");
    console.log("\nVerification mode after deploy: proof_card_commitment_only (spec §15).");
    process.exit(0);
  }
  console.error(
    "Automated deploy requires the Soroban CLI in this environment; follow the printed steps.",
  );
  process.exit(1);
}
main();
