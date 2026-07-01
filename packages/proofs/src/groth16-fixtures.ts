/**
 * Shared fixtures + raw-snarkjs helpers for the Phase 3 Groth16 test matrix.
 * NOT exported from the package index — test-only. Builds deterministic capsules
 * for each recipe and a `proveRaw` that drives snarkjs directly so tests can
 * tamper the circom input and assert the CIRCUIT (not just the JS verifier)
 * rejects it.
 */
import { readFile } from "node:fs/promises";
import type { ComputeIntent, SemanticFact } from "@sefi/shared-types";
import { buildSourceRecord } from "@sefi/source-records";
import { buildFact } from "@sefi/semantic-core";
import { buildCapsule } from "@sefi/context-capsules";
import { compileIntent, evaluateCompute, RECIPES } from "@sefi/compute";
import { buildWitness, witnessToCircomInput } from "./witness.js";
import { groth16ArtifactPaths } from "./groth16.js";

const ADAPTER = "0x" + "a1".repeat(32);

function src(protocol: any) {
  return buildSourceRecord({
    network: "mainnet", protocol, sourceKind: "stellar_rpc_simulate",
    response: { x: 1 }, ledgerSeq: 1000, adapterName: String(protocol), adapterVersion: "1.0.0", adapterHash: ADAPTER,
  });
}

export interface Fixture {
  capsule: ReturnType<typeof buildCapsule>;
  facts: SemanticFact[];
  intent: ComputeIntent;
}

export function blendFixture(borrowed: string, supplied: string, oracle: string, maxUtil = "0.82"): Fixture {
  const s = src("blend");
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalBorrowed", value: borrowed, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "reserve", entityId: "blend_pool:C:USDC", field: "reserve.totalSupplied", value: supplied, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "blend", entityType: "oracle", entityId: "oracle:C", field: "oracle.freshness", value: oracle, sources: [s] }),
  ];
  return {
    capsule: buildCapsule({ network: "mainnet", protocols: ["blend"], facts, sourceRecords: [s] }),
    facts,
    intent: {
      name: "blend-utilization-policy", context: {}, compute: RECIPES["blend-utilization-policy"],
      privateInputs: { maxUtilization: maxUtil }, privateInputSchema: { maxUtilization: "fixed_1e6" },
      reveal: ["safe"], hide: ["maxUtilization"],
      proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
    },
  };
}

export function aquariusFixture(estOut: string, hops: number, minOut = "99000000"): Fixture {
  const s = src("aquarius");
  const id = "aqua_route:USDC:XLM:1000000000";
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "slippage.estimated_out", value: estOut, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: id, field: "route.hops", value: hops, sources: [s] }),
  ];
  return {
    capsule: buildCapsule({ network: "mainnet", protocols: ["aquarius"], facts, sourceRecords: [s] }),
    facts,
    intent: {
      name: "aquarius-route-policy", context: {}, compute: RECIPES["aquarius-route-policy"],
      privateInputs: { minOut }, privateInputSchema: { minOut: "u128" },
      reveal: ["routeAcceptable"], hide: ["minOut"],
      proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
    },
  };
}

export function sdexFixture(
  avail: boolean, out: string, spread: number, minReceive = "99000000", maxSpreadBps = "50",
): Fixture {
  const s = src("stellar_dex");
  const routeId = "sdex_route:USDC:XLM";
  const mktId = "sdex_mkt:USDC:XLM";
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: routeId, field: "path.available", value: avail, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: routeId, field: "path.estimated_out", value: out, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "market", entityId: mktId, field: "market.spread_bps", value: spread, sources: [s] }),
  ];
  return {
    capsule: buildCapsule({ network: "mainnet", protocols: ["stellar_dex"], facts, sourceRecords: [s] }),
    facts,
    intent: {
      name: "sdex-exit-policy", context: {}, compute: RECIPES["sdex-exit-policy"],
      privateInputs: { minReceive, maxSpreadBps }, privateInputSchema: { minReceive: "u128", maxSpreadBps: "u64" },
      reveal: ["exitOk"], hide: ["minReceive", "maxSpreadBps"],
      proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
    },
  };
}

export function compositeFixture(
  health: string, estOut: string, hops: number, avail: boolean, pathOut: string,
  minHealth = "1.25", minReceive = "99000000",
): Fixture {
  const s = src("blend");
  const sa = src("aquarius");
  const sd = src("stellar_dex");
  const aid = "aqua_route:USDC:XLM:1000000000";
  const rid = "sdex_route:USDC:XLM";
  const facts: SemanticFact[] = [
    buildFact({ network: "mainnet", protocol: "blend", entityType: "position", entityId: "blend_pos:C:GABC", field: "health.factor", value: health, sources: [s] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "slippage.estimated_out", value: estOut, sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "aquarius", entityType: "route", entityId: aid, field: "route.hops", value: hops, sources: [sa] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.available", value: avail, sources: [sd] }),
    buildFact({ network: "mainnet", protocol: "stellar_dex", entityType: "route", entityId: rid, field: "path.estimated_out", value: pathOut, sources: [sd] }),
  ];
  return {
    capsule: buildCapsule({ network: "mainnet", protocols: ["blend", "aquarius", "stellar_dex"], facts, sourceRecords: [s, sa, sd] }),
    facts,
    intent: {
      name: "composite-borrow-exit-policy", context: {}, compute: RECIPES["composite-borrow-exit-policy"],
      privateInputs: { minHealth, minReceive }, privateInputSchema: { minHealth: "fixed_1e6", minReceive: "u128" },
      reveal: ["allowed"], hide: ["minHealth", "minReceive"],
      proof: { backend: "bn254-groth16", verifyOn: "stellar", proveDataUsed: true },
    },
  };
}

/** Build the exact circom input a fixture would prove (for tamper tests). */
export function circomInputFor(fx: Fixture): Record<string, string | string[]> {
  const compiled = compileIntent({ intent: fx.intent, capsule: fx.capsule, facts: fx.facts });
  const evaluation = evaluateCompute(compiled, fx.intent.privateInputs, fx.facts, {});
  const witness = buildWitness({
    recipe: fx.intent.name, compiled, capsule: fx.capsule, facts: fx.facts, evaluation,
    privateInputs: fx.intent.privateInputs,
  });
  return witnessToCircomInput(witness);
}

/**
 * Serialize only the surfaces the trust model protects (proof card, public
 * inputs, revealed result, warnings) — NOT the cryptographic proof bytes /
 * public signals, whose big decimal field values contain arbitrary digit runs.
 * A private threshold appearing here is a real leak.
 */
export function leakSurface(result: {
  proofCard: unknown;
  proofEnvelope: { publicInputs: unknown; revealed: unknown };
  publicInputs?: unknown;
}): string {
  return JSON.stringify({
    proofCard: result.proofCard,
    publicInputs: result.proofEnvelope.publicInputs,
    revealed: result.proofEnvelope.revealed,
  });
}

async function terminateCurve() {
  try {
    const g = globalThis as any;
    if (g.curve_bn128?.terminate) { await g.curve_bn128.terminate(); g.curve_bn128 = null; }
  } catch { /* best effort */ }
}

/** Drive snarkjs directly on a circom input. Returns null if fullProve throws. */
export async function proveRaw(
  recipe: string, input: Record<string, string | string[]>,
): Promise<{ publicSignals: string[]; ok: boolean } | null> {
  const a = groth16ArtifactPaths(recipe);
  const { groth16 } = (await import("snarkjs" as string)) as any;
  try {
    const { proof, publicSignals } = await groth16.fullProve(input, a.wasm, a.zkey);
    const vkey = JSON.parse(await readFile(a.vkey, "utf8"));
    const ok = await groth16.verify(vkey, publicSignals, proof);
    return { publicSignals, ok };
  } catch {
    return null; // constraint not satisfied — the circuit rejected the witness
  } finally {
    await terminateCurve();
  }
}
