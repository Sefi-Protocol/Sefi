/** One-shot Blend ingestion (spec §3.1 scripts). Usage: pnpm ingest:blend <poolId> [wallet] */
import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";

const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;
const poolId =
  process.argv[2] ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const wallet = process.argv[3];

async function main() {
  const sefi = new SefiClient({ network: NETWORK, aquariusRouter: process.env.AQUARIUS_ROUTER }, createStore());
  const ctx = await sefi.blend().getPoolContext({ poolId, wallet });
  console.log(JSON.stringify({ facts: ctx.facts, warnings: ctx.warnings }, null, 2));
  console.log(`\ningested ${ctx.facts.length} blend facts, ${ctx.sourceRecords.length} source records`);
}
main().catch((e) => (console.error(e), process.exit(1)));
