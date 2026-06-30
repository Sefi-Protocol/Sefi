/** One-shot Aquarius ingestion. Usage: pnpm ingest:aquarius <tokenIn> <tokenOut> <amountIn> */
import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";

const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;
const tokenIn = process.argv[2] ?? "USDC";
const tokenOut = process.argv[3] ?? "XLM";
const amountIn = process.argv[4] ?? "1000000000";

async function main() {
  const sefi = new SefiClient({ network: NETWORK, aquariusRouter: process.env.AQUARIUS_ROUTER }, createStore());
  const ctx = await sefi.aquarius().estimateSwap({ tokenIn, tokenOut, amountIn });
  console.log(JSON.stringify({ facts: ctx.facts, warnings: ctx.warnings }, null, 2));
  console.log(`\ningested ${ctx.facts.length} aquarius facts, ${ctx.sourceRecords.length} source records`);
}
main().catch((e) => (console.error(e), process.exit(1)));
