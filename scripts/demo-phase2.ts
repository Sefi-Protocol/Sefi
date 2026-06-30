/**
 * Sefi Phase 2 demo (spec §24). Runs the full ComputeKit + ProofKit flow over
 * live mainnet in one process: build context capsule, verify it, compile a
 * ComputeIntent, prove it (private inputs redacted), verify the proof locally,
 * and emit a proof card — for both the Blend-only and composite policies.
 */
import { SefiClient } from "@sefi/sdk";
import { RECIPES } from "@sefi/compute";
import { verifyCapsule } from "@sefi/context-capsules";
import { verifyLocal } from "@sefi/proofs";
import { createStore } from "@sefi/store";

const POOL =
  process.env.SEFI_DEMO_POOL ?? "CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OI2SKMFJNVAMDX6DP";
const WALLET = process.env.SEFI_DEMO_WALLET;
const AMOUNT = process.env.SEFI_DEMO_AMOUNT ?? "1000000000";

function ok(msg: string) {
  console.log(`✓ ${msg}`);
}

async function main() {
  const store = createStore();
  const sefi = new SefiClient({ network: "mainnet" }, store);

  console.log("SEFI PHASE 2 DEMO\n");

  // 1) Blend-only intent: compile (builds + persists the context capsule).
  const blendIntent = {
    name: "blend-utilization-policy",
    context: { blend: { poolId: POOL, include: ["reserves", "oracle"] } },
    compute: RECIPES["blend-utilization-policy"],
    privateInputs: { maxUtilization: "820000" },
    reveal: ["safe"],
    hide: ["maxUtilization"],
    proof: { backend: "auto" as const, verifyOn: "offchain" as const, proveDataUsed: true },
  };
  const compiled = await sefi.compute().compile(blendIntent);

  // Verify the capsule the compiled intent bound to.
  const capsule = await store.getCapsule(compiled.capsuleId);
  const capFacts = await store.getCapsuleFacts(compiled.capsuleId);
  const capSrcs = await store.getCapsuleSourceRecords(compiled.capsuleId);
  const cv = verifyCapsule(capsule!, capFacts, capSrcs);
  if (!cv.ok) throw new Error("capsule verification failed");
  ok("context capsule verified");
  if (capsule!.semanticFactsRoot !== compiled.semanticFactsRoot)
    throw new Error("semantic fact root mismatch");
  ok("semantic fact root verified");
  ok("ComputeIntent compiled");

  const blend = await sefi.compute().prove(blendIntent);
  const leak = JSON.stringify(blend).includes("820000");
  if (leak) throw new Error("private input leaked!");
  ok("private inputs redacted");
  ok("proof envelope created");
  const v1 = await verifyLocal(blend.proofEnvelope);
  if (!v1.valid) throw new Error("blend local verify failed: " + v1.reasons.join("; "));
  ok("local verification OK");
  ok("proof card generated");

  // 2) Composite proof (needs a wallet for the health fact; otherwise Blend+Aqua+SDEX exit).
  let compositeResult = "SKIPPED (set SEFI_DEMO_WALLET=G... for the health fact)";
  if (WALLET) {
    const comp = await sefi.compute().prove({
      name: "composite-borrow-exit-policy",
      context: {
        blend: { poolId: POOL, wallet: WALLET, include: ["reserves", "oracle", "positions"] },
        aquarius: { route: { tokenIn: "USDC", tokenOut: "XLM", amountIn: AMOUNT } },
        sdex: { path: { sourceAsset: "USDC", destinationAsset: "XLM", sourceAmount: AMOUNT } },
      },
      compute: RECIPES["composite-borrow-exit-policy"],
      privateInputs: { minHealth: "1.25", minReceive: "1" },
      reveal: ["allowed"],
      hide: ["minHealth", "minReceive"],
      proof: { backend: "auto", verifyOn: "offchain", proveDataUsed: true },
    });
    const v2 = await verifyLocal(comp.proofEnvelope);
    if (!v2.valid) throw new Error("composite verify failed");
    compositeResult = comp.proofCard.publicResult.allowed ? "ALLOWED" : "NOT ALLOWED";
  }

  console.log("\nTrust model: proof-of-data-used, not proof-of-data-origin.");
  console.log("Blend utilization policy:", blend.proofCard.publicResult.safe ? "SAFE" : "NOT SAFE");
  console.log("Composite borrow-exit policy:", compositeResult);
}

main().catch((e) => (console.error(e.stack || e.message), process.exit(1)));
