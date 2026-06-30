/**
 * Verify a stored BN254-Noir proof envelope (audit follow-up #6:
 * `pnpm verify:proof:bn254 <proofId>`). Loads the envelope + linked compiled
 * intent + capsule, recomputes the full chain, and runs the bn254-noir backend
 * verifier (bb verify). Requires the same store the proof was created in.
 */
import { createStore } from "@sefi/store";
import { verifyLocal } from "@sefi/proofs";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: pnpm verify:proof:bn254 <proofId>");
    process.exit(1);
  }
  const store = createStore();
  const envelope = await store.getProofEnvelope(id);
  if (!envelope) {
    console.error(`proof ${id} not found in this store`);
    process.exit(1);
  }
  if (envelope.backend !== "bn254-noir") {
    console.log(`note: proof ${id} backend is "${envelope.backend}", not bn254-noir.`);
  }
  const compiled =
    (await store.getComputeIntentByProof(id)) ?? undefined;
  try {
    const result = await verifyLocal(envelope, compiled);
    console.log(JSON.stringify({ proofId: id, backend: envelope.backend, ...result }, null, 2));
    console.log(result.valid ? "\n✅ bn254 proof verified" : "\n❌ proof invalid");
    if (store.close) await store.close();
    process.exit(result.valid ? 0 : 1);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("SEFI_BN254_TOOLCHAIN_MISSING")) {
      console.log("SKIP: " + msg);
      process.exit(0);
    }
    throw e;
  }
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
