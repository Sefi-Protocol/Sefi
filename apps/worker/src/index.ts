import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";

/**
 * Background ingestion worker (spec §16). Refreshes selected protocol surfaces
 * on the cadences recommended in spec §4.3. Targets come from env; sensible
 * testnet defaults are provided. Runs against the canonical store so the API
 * serves cached facts (background ingestion mode, spec §4.2).
 */
const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;

const BLEND_POOLS = (process.env.SEFI_BLEND_POOLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const AQUA_PAIRS = (process.env.SEFI_AQUA_PAIRS ?? "USDC:XLM")
  .split(",")
  .map((s) => s.trim().split(":"))
  .filter((p) => p.length === 2);
const SDEX_MARKETS = (process.env.SEFI_SDEX_MARKETS ?? "XLM:USDC")
  .split(",")
  .map((s) => s.trim().split(":"))
  .filter((p) => p.length === 2);

const store = createStore();
const sefi = new SefiClient(
  {
    network: NETWORK,
    rpcUrl: process.env.SEFI_RPC_URL,
    horizonUrl: process.env.SEFI_HORIZON_URL,
    aquariusRouter: process.env.AQUARIUS_ROUTER,
  },
  store,
);

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

async function refreshBlend() {
  if (!BLEND_POOLS.length) return; // set SEFI_BLEND_POOLS to enable
  for (const poolId of BLEND_POOLS) {
    try {
      const ctx = await sefi.blend().getPoolContext({ poolId });
      log(`blend ${poolId}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`blend ${poolId} failed: ${(e as Error).message}`);
    }
  }
}

async function refreshAquarius() {
  for (const [tokenA, tokenB] of AQUA_PAIRS) {
    try {
      const ctx = await sefi.aquarius().getPools({ tokenA, tokenB });
      log(`aquarius ${tokenA}/${tokenB}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`aquarius ${tokenA}/${tokenB} failed: ${(e as Error).message}`);
    }
  }
}

async function refreshSdex() {
  for (const [base, counter] of SDEX_MARKETS) {
    try {
      const ctx = await sefi.sdex().getMarket({ base, counter });
      log(`sdex ${base}/${counter}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`sdex ${base}/${counter} failed: ${(e as Error).message}`);
    }
  }
}

function every(seconds: number, fn: () => Promise<void>) {
  const run = () => fn().catch((e) => log(`job error: ${e.message}`));
  run();
  return setInterval(run, seconds * 1000);
}

async function main() {
  log(`starting (network=${NETWORK}, live)`);
  // Frequencies per spec §4.3.
  every(60, refreshBlend); // Blend top pools — 60s
  every(60, refreshAquarius); // Aquarius top pools — 60s
  every(45, refreshSdex); // SDEX order books — 30-60s

  if (process.env.SEFI_WORKER_ONCE === "1") {
    await Promise.all([refreshBlend(), refreshAquarius(), refreshSdex()]);
    log("single pass complete (SEFI_WORKER_ONCE=1), exiting");
    process.exit(0);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
