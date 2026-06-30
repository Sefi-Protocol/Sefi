import type { ComputeIntent, ProofJob } from "@sefi/shared-types";
import { SefiClient } from "@sefi/sdk";
import { createStore } from "@sefi/store";

/**
 * Async proof job runner (spec §19). Keeps heavy proofs off the API request
 * path. For MVP the API can prove small policies synchronously; this worker
 * exists so larger / Noir proofs can be queued. It exposes an in-process queue
 * API used by tests and a CLI single-job mode.
 */
const store = createStore();
const sefi = new SefiClient(
  {
    network: (process.env.SEFI_NETWORK as "mainnet" | "testnet") ?? "mainnet",
    aquariusRouter: process.env.AQUARIUS_ROUTER,
  },
  store,
);

const queue: Array<{ job: ProofJob; intent: ComputeIntent }> = [];

export function enqueue(intent: ComputeIntent): ProofJob {
  const job: ProofJob = {
    id: `job_${queue.length + 1}`,
    intentId: intent.id ?? "",
    backend: intent.proof.backend === "auto" ? "prebuilt" : intent.proof.backend,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  queue.push({ job, intent });
  return job;
}

async function process() {
  const item = queue.shift();
  if (!item) return;
  item.job.status = "running";
  try {
    const result = await sefi.compute().prove(item.intent);
    item.job.status = result.proofCard.result === "verified" ? "verified" : "failed";
    // eslint-disable-next-line no-console
    console.log(`[proof-worker] ${item.job.id} -> ${item.job.status} (${result.proofEnvelope.proofId})`);
  } catch (e) {
    item.job.status = "failed";
    item.job.error = (e as Error).message;
    // eslint-disable-next-line no-console
    console.error(`[proof-worker] ${item.job.id} failed: ${item.job.error}`);
  }
  item.job.updatedAt = new Date().toISOString();
}

async function main() {
  // eslint-disable-next-line no-console
  console.log("[proof-worker] started; polling every 2s");
  setInterval(() => void process(), 2000);
}

if (process.env.SEFI_PROOF_WORKER_RUN !== "0") {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
