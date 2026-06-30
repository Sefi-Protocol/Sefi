/**
 * Replay / verify a stored context capsule (spec §20.4). Requires DATABASE_URL.
 * Usage: DATABASE_URL=... pnpm replay <capsuleId>
 */
import { createStore } from "@sefi/store";
import { verifyCapsule } from "@sefi/context-capsules";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: pnpm replay <capsuleId>");
    process.exit(1);
  }
  const store = createStore();
  const capsule = await store.getCapsule(id);
  if (!capsule) {
    console.error(`capsule ${id} not found`);
    process.exit(1);
  }
  const facts = await store.getCapsuleFacts(id);
  const sources = await store.getCapsuleSourceRecords(id);
  const result = verifyCapsule(capsule, facts, sources);
  console.log(JSON.stringify({ capsule, verify: result }, null, 2));
  console.log(result.ok ? "\n✅ replay verified" : "\n❌ replay mismatch");
  if (store.close) await store.close();
  process.exit(result.ok ? 0 : 1);
}
main().catch((e) => (console.error(e), process.exit(1)));
