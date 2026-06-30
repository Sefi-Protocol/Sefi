/** One-shot SDEX ingestion. Usage: pnpm ingest:sdex <base> <counter> */
import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";

const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;
const base = process.argv[2] ?? "XLM";
const counter = process.argv[3] ?? "USDC";

async function main() {
  const sefi = new SefiClient({ network: NETWORK, aquariusRouter: process.env.AQUARIUS_ROUTER }, createStore());
  const ctx = await sefi.sdex().getMarket({ base, counter });
  console.log(JSON.stringify({ facts: ctx.facts, warnings: ctx.warnings }, null, 2));
  console.log(`\ningested ${ctx.facts.length} sdex facts, ${ctx.sourceRecords.length} source records`);
}
main().catch((e) => (console.error(e), process.exit(1)));
