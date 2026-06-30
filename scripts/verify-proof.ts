/** Verify a stored proof envelope locally (spec §24). Usage: pnpm verify:proof <proofId> */
import { createStore } from "@sefi/store";
import { verifyLocal } from "@sefi/proofs";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: pnpm verify:proof <proofId>  (requires the same store/DATABASE_URL)");
    process.exit(1);
  }
  const store = createStore();
  const envelope = await store.getProofEnvelope(id);
  if (!envelope) {
    console.error(`proof ${id} not found in this store`);
    process.exit(1);
  }
  const result = await verifyLocal(envelope);
  console.log(JSON.stringify({ proofId: id, ...result }, null, 2));
  console.log(result.valid ? "\n✅ proof verified locally" : "\n❌ proof invalid");
  if (store.close) await store.close();
  process.exit(result.valid ? 0 : 1);
}
main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
