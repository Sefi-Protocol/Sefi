import type { Network } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";
import { buildSourceRecord, computeAdapterHash } from "@sefi/source-records";

/**
 * Background ingestion workers (spec §16) on the cadences from spec §4.3. The
 * full named-worker set is implemented:
 *   blend-pool-worker          — refresh configured Blend pools (60s)
 *   blend-event-worker         — checkpointed getEvents ingestion (60s)
 *   aquarius-pool-worker       — refresh Aquarius pool info (60s)
 *   aquarius-swap-cache-worker — pre-warm common swap estimates (60s)
 *   sdex-orderbook-worker      — refresh SDEX markets (45s)
 *   sdex-liquiditypool-worker  — poll classic liquidity pools (60s)
 *   capsule-cleanup-worker     — prune capsules past the retention window (1h)
 * Everything is live; all writes go to the canonical store.
 */
const NETWORK = (process.env.SEFI_NETWORK ?? "mainnet") as Network;

const list = (v: string | undefined) =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const pairs = (v: string | undefined) =>
  list(v).map((s) => s.split(":")).filter((p) => p.length === 2) as [string, string][];

const BLEND_POOLS = list(process.env.SEFI_BLEND_POOLS);
const AQUA_PAIRS = pairs(process.env.SEFI_AQUA_PAIRS ?? "USDC:XLM");
const SDEX_MARKETS = pairs(process.env.SEFI_SDEX_MARKETS ?? "XLM:USDC");
const SWAP_CACHE_AMOUNTS = list(process.env.SEFI_SWAP_AMOUNTS ?? "1000000000"); // 100 USDC
const CAPSULE_TTL_HOURS = Number(process.env.SEFI_CAPSULE_TTL_HOURS ?? 24);

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

const EVENT_ADAPTER_HASH = computeAdapterHash("blend-event-worker", "1.0.0", "events-v1");
const checkpointId = (poolId: string) => `blend-event-worker:blend:${poolId}`;

function log(msg: string) {
  // eslint-disable-next-line no-console
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

/** Recursively convert BigInt -> string so event payloads are JSON/JSONB-safe. */
function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = jsonSafe(val);
    return o;
  }
  return v;
}

// ---- workers -------------------------------------------------------------

async function blendPoolWorker() {
  for (const poolId of BLEND_POOLS) {
    try {
      const ctx = await sefi.blend().getPoolContext({ poolId });
      log(`blend-pool ${poolId.slice(0, 6)}…: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`blend-pool ${poolId.slice(0, 6)}… failed: ${(e as Error).message}`);
    }
  }
}

/** Checkpointed Soroban event ingestion: stores raw event source records. */
async function blendEventWorker() {
  for (const poolId of BLEND_POOLS) {
    try {
      // Resume from the persisted checkpoint (audit Part J §1).
      const cp = await store.getCheckpoint(checkpointId(poolId));
      const cursor = cp?.cursor;
      const res = await sefi.client.getEvents({
        contractIds: [poolId],
        cursor,
        startLedger: cursor ? undefined : (await sefi.client.getLatestLedger()) - 1000,
        limit: 100,
      });
      if (res.events.length) {
        const sources = res.events.map((ev) =>
          buildSourceRecord({
            network: NETWORK,
            protocol: "blend",
            sourceKind: "stellar_rpc_events",
            contractId: poolId,
            functionName: `event:${ev.type}`,
            response: jsonSafe({ topic: ev.topic, value: ev.value, ledger: ev.ledger, id: ev.id }),
            ledgerSeq: ev.ledger,
            latestLedger: res.latestLedger,
            adapterName: "blend-event-worker",
            adapterVersion: "1.0.0",
            adapterHash: EVENT_ADAPTER_HASH,
          }),
        );
        await store.saveSourceRecords(sources);
      }
      await store.saveCheckpoint({
        id: checkpointId(poolId),
        worker: "blend-event-worker",
        protocol: "blend",
        contractId: poolId,
        cursor: res.cursor,
        latestLedger: res.latestLedger,
        updatedAt: new Date().toISOString(),
      });
      log(`blend-event ${poolId.slice(0, 6)}…: +${res.events.length} events (cursor persisted)`);
    } catch (e) {
      log(`blend-event ${poolId.slice(0, 6)}… failed: ${(e as Error).message}`);
    }
  }
}

async function aquariusPoolWorker() {
  for (const [tokenA, tokenB] of AQUA_PAIRS) {
    try {
      const ctx = await sefi.aquarius().getPools({ tokenA, tokenB });
      log(`aquarius-pool ${tokenA}/${tokenB}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`aquarius-pool ${tokenA}/${tokenB} failed: ${(e as Error).message}`);
    }
  }
}

/** Pre-warm common swap estimates so agent answers are fast (spec §16). */
async function aquariusSwapCacheWorker() {
  for (const [tokenA, tokenB] of AQUA_PAIRS) {
    for (const amountIn of SWAP_CACHE_AMOUNTS) {
      try {
        const ctx = await sefi.aquarius().estimateSwap({ tokenIn: tokenA, tokenOut: tokenB, amountIn });
        log(`aquarius-swap-cache ${tokenA}->${tokenB} ${amountIn}: ${ctx.facts.length} facts`);
      } catch (e) {
        log(`aquarius-swap-cache ${tokenA}->${tokenB} failed: ${(e as Error).message}`);
      }
    }
  }
}

async function sdexOrderbookWorker() {
  for (const [base, counter] of SDEX_MARKETS) {
    try {
      const ctx = await sefi.sdex().getMarket({ base, counter });
      log(`sdex-orderbook ${base}/${counter}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`sdex-orderbook ${base}/${counter} failed: ${(e as Error).message}`);
    }
  }
}

async function sdexLiquidityPoolWorker() {
  for (const [base, counter] of SDEX_MARKETS) {
    try {
      const ctx = await sefi.sdex().getLiquidityPools({ base, counter });
      log(`sdex-lp ${base}/${counter}: ${ctx.facts.length} facts`);
    } catch (e) {
      log(`sdex-lp ${base}/${counter} failed: ${(e as Error).message}`);
    }
  }
}

async function capsuleCleanupWorker() {
  const before = new Date(Date.now() - CAPSULE_TTL_HOURS * 3600_000).toISOString();
  try {
    const n = await store.deleteCapsulesOlderThan(before);
    log(`capsule-cleanup: removed ${n} capsules older than ${CAPSULE_TTL_HOURS}h`);
  } catch (e) {
    log(`capsule-cleanup failed: ${(e as Error).message}`);
  }
}

// ---- scheduler -----------------------------------------------------------

function every(seconds: number, fn: () => Promise<void>) {
  const run = () => fn().catch((e) => log(`job error: ${e.message}`));
  run();
  return setInterval(run, seconds * 1000);
}

async function main() {
  log(`starting (network=${NETWORK}, live)`);
  if (!BLEND_POOLS.length)
    log("note: SEFI_BLEND_POOLS unset — blend-pool/blend-event workers idle");

  const jobs = [
    every(60, blendPoolWorker),
    every(60, blendEventWorker),
    every(60, aquariusPoolWorker),
    every(60, aquariusSwapCacheWorker),
    every(45, sdexOrderbookWorker),
    every(60, sdexLiquidityPoolWorker),
    every(3600, capsuleCleanupWorker),
  ];

  if (process.env.SEFI_WORKER_ONCE === "1") {
    jobs.forEach(clearInterval);
    await Promise.all([
      blendPoolWorker(),
      blendEventWorker(),
      aquariusPoolWorker(),
      aquariusSwapCacheWorker(),
      sdexOrderbookWorker(),
      sdexLiquidityPoolWorker(),
      capsuleCleanupWorker(),
    ]);
    log("single pass complete (SEFI_WORKER_ONCE=1), exiting");
    process.exit(0);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
