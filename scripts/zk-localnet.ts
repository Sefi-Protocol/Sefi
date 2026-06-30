/**
 * `pnpm zk:localnet` — Sefi does NOT use a Stellar localnet; the BN254 verifier
 * is deployed and verified on Stellar **testnet**. This shim runs the real
 * testnet verification (scripts/verify-groth16-testnet.ts) so the required
 * command name still works.
 */
console.log("localnet disabled — Sefi verifies on Stellar testnet; running zk:testnet flow.\n");
await import("./verify-groth16-testnet.ts");
