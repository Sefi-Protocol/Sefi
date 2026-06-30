import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComputeIntent } from "@sefi/shared-types";
import { compileIntent } from "@sefi/compute";
import { selectBackend } from "./router.js";
import { proveComputeIntent } from "./prove.js";
import { verifyLocal } from "./verify.js";

// testutil is internal to @sefi/compute; re-create a minimal capsule here.
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";

const ADAPTER = "0x" + "a1".repeat(32);

function blendFixture(borrowed: string, supplied: string, oracle: string) {
  const src = buildSourceRecord({
    network: "mainnet",
    protocol: "blend",
    sourceKind: "stellar_rpc_simulate",
    response: { x: 1 },
    ledgerSeq: 1000,
    adapterName: "blend",
    adapterVersion: "1.0.0",
    adapterHash: ADAPTER,
  });
  const facts = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: borrowed, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: supplied, sources: [src] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: oracle, sources: [src] }),
  ];
  const capsule = buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [src] });
  return { capsule, facts };
}

// Explicit prebuilt backend: deterministic + no toolchain needed for these
// envelope/verify tests. Backend-policy routing is tested separately below.
const INTENT: ComputeIntent = {
  name: "blend-utilization-policy",
  context: {},
  compute:
    "utilization = blend.reserve.USDC.totalBorrowed * SCALE / max(blend.reserve.USDC.totalSupplied, 1); safe = utilization < private.maxUtilization && blend.oracle.isFresh;",
  privateInputs: { maxUtilization: "0.82" },
  privateInputSchema: { maxUtilization: "fixed_1e6" },
  reveal: ["safe"],
  hide: ["maxUtilization"],
  proof: { backend: "prebuilt", verifyOn: "offchain", proveDataUsed: true },
};

test("auto routes named recipe to bn254-groth16 by default (no silent prebuilt)", () => {
  const { capsule, facts } = blendFixture("7", "10", "fresh");
  const autoIntent = { ...INTENT, proof: { ...INTENT.proof, backend: "auto" as const } };
  const compiled = compileIntent({ intent: autoIntent, capsule, facts });
  const prev = process.env.SEFI_ALLOW_PREBUILT_PROOFS;
  delete process.env.SEFI_ALLOW_PREBUILT_PROOFS;
  // Default real path is bn254-groth16 (a real Groth16 proof of the actual
  // ComputeIntent that verifies on the Soroban verifier).
  assert.equal(selectBackend(autoIntent, compiled), "bn254-groth16");
  // With explicit opt-in, prebuilt is allowed.
  process.env.SEFI_ALLOW_PREBUILT_PROOFS = "1";
  assert.equal(selectBackend(autoIntent, compiled), "prebuilt");
  if (prev === undefined) delete process.env.SEFI_ALLOW_PREBUILT_PROOFS;
  else process.env.SEFI_ALLOW_PREBUILT_PROOFS = prev;
});

test("production blocks auto local-dev and prebuilt unless explicitly enabled", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.SEFI_ALLOW_PREBUILT_PROOFS;
  delete process.env.SEFI_ALLOW_LOCAL_DEV_PROOFS;
  // explicit prebuilt is blocked in production
  await assert.rejects(
    () => proveComputeIntent({ intent: { ...INTENT, proof: { ...INTENT.proof, backend: "prebuilt" } }, capsule, facts }),
    /SEFI_BACKEND_BLOCKED/,
  );
  // explicit local-dev is blocked in production
  await assert.rejects(
    () => proveComputeIntent({ intent: { ...INTENT, name: "custom", proof: { ...INTENT.proof, backend: "local-dev" } }, capsule, facts }),
    /SEFI_BACKEND_BLOCKED|SEFI_LOCAL_DEV_DISABLED/,
  );
  process.env.NODE_ENV = prevEnv;
});

test("bn254-noir fails clearly when toolchain is missing (no fallback)", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  // Only run the assertion when nargo/bb are absent (the case in this env).
  const { detectNoirToolchain } = await import("./noir.js");
  const tc = await detectNoirToolchain();
  if (tc.nargo && tc.bb) return; // real proving covered by zk:test on a configured machine
  await assert.rejects(
    () => proveComputeIntent({ intent: { ...INTENT, proof: { ...INTENT.proof, backend: "bn254-noir" } }, capsule, facts }),
    /SEFI_BN254_TOOLCHAIN_MISSING/,
  );
});

test("prove returns envelope + card with public roots, no private values", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: INTENT, capsule, facts });
  assert.equal(result.proofCard.result, "verified");
  assert.deepEqual(result.proofCard.publicResult, { safe: true });
  assert.equal(result.proofCard.trustModel, "proof-of-data-used");
  assert.ok(result.publicInputs.contextRoot.startsWith("0x"));
  assert.ok(result.publicInputs.semanticFactsRoot.startsWith("0x"));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("820000"), "private value must not appear");
});

test("verifyLocal validates a genuine envelope", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result, compiled } = await proveComputeIntent({ intent: INTENT, capsule, facts });
  const v = await verifyLocal(result.proofEnvelope, compiled);
  assert.ok(v.valid, v.reasons.join("; "));
});

test("verifyLocal rejects tampered revealed result", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: INTENT, capsule, facts });
  const tampered = { ...result.proofEnvelope, revealed: { safe: false } };
  const v = await verifyLocal(tampered);
  assert.equal(v.valid, false);
});

test("verifyLocal rejects tampered contextRoot", async () => {
  const { capsule, facts } = blendFixture("700000000000", "1000000000000", "fresh");
  const { result } = await proveComputeIntent({ intent: INTENT, capsule, facts });
  const tampered = {
    ...result.proofEnvelope,
    publicInputs: { ...result.proofEnvelope.publicInputs, contextRoot: ("0x" + "0".repeat(64)) as `0x${string}` },
  };
  const v = await verifyLocal(tampered);
  assert.equal(v.valid, false);
});

test("local-dev disabled in production without opt-in", async () => {
  const { capsule, facts } = blendFixture("7", "10", "fresh");
  const localIntent: ComputeIntent = { ...INTENT, name: "custom-policy", proof: { ...INTENT.proof, backend: "local-dev" } };
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.SEFI_ALLOW_LOCAL_DEV_PROOFS;
  await assert.rejects(
    () => proveComputeIntent({ intent: localIntent, capsule, facts }),
    /SEFI_LOCAL_DEV_DISABLED|SEFI_BACKEND_BLOCKED/,
  );
  process.env.NODE_ENV = prev;
});
