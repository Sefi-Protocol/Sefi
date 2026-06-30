/**
 * BN254 / Noir witness generation (audit follow-up #1, #2).
 *
 * Builds the COMPLETE witness every circuit needs — public roots, each bound
 * fact's value/pathId/adapterHash/ledgerSeq, the per-fact Poseidon Merkle
 * inclusion path (siblings + index bits) against the capsule's zkFactsRoot, and
 * the private thresholds — and serialises it to a Noir `Prover.toml`.
 *
 * It also ships a TypeScript *reference circuit evaluator* that mirrors each
 * Noir circuit exactly (recompute leaf hashes, verify Merkle paths, recompute
 * zkContextRoot, apply the predicate). This lets us validate that a generated
 * witness is complete and correct — and would be accepted by `nargo execute` —
 * without the Noir toolchain installed.
 */
import type {
  CompiledComputeIntent,
  ComputeEvaluation,
  ContextCapsule,
  SemanticFact,
} from "@sefi/shared-types";
import {
  BN254_FR_MODULUS,
  ZK_MERKLE_DEPTH,
  ZK_SCALE,
  bytes32ToFr,
  factPathId,
  factValueToFr,
  hashFactToFr,
  buildFixedTree,
  fixedTreeProof,
  poseidonHash2,
  poseidonHash3,
  poseidonHash4,
} from "@sefi/source-records";

const poseidon2 = (a: [bigint, bigint]) => poseidonHash2(a[0], a[1]);
const poseidon3 = (a: [bigint, bigint, bigint]) => poseidonHash3(a[0], a[1], a[2]);
const poseidon4 = (a: [bigint, bigint, bigint, bigint]) => poseidonHash4(a[0], a[1], a[2], a[3]);

export interface FactWitness {
  slot: string;
  variable: string;
  value: bigint;
  pathId: bigint;
  adapterHash: bigint;
  ledgerSeq: bigint;
  siblings: bigint[];
  bits: number[];
}

export interface CircuitWitness {
  recipe: string;
  public: {
    zkContextRoot: bigint;
    zkFactsRoot: bigint;
    computeHash: bigint;
    resultHash: bigint;
    sourceRoot: bigint;
    adapterSetHash: bigint;
  };
  facts: FactWitness[];
  thresholds: Record<string, bigint>;
  revealed: boolean;
}

interface ThresholdSpec {
  name: string;
  type: "fixed_1e6" | "u128" | "u64";
}

interface RecipeSpec {
  /** circuit slot -> DSL variable path (in circuit order). */
  slots: Record<string, string>;
  thresholds: ThresholdSpec[];
  /** Reference predicate over normalized field values + thresholds. */
  predicate: (f: Record<string, bigint>, t: Record<string, bigint>) => boolean;
}

const RECIPE_SPECS: Record<string, RecipeSpec> = {
  "blend-utilization-policy": {
    slots: {
      borrowed: "blend.reserve.USDC.totalBorrowed",
      supplied: "blend.reserve.USDC.totalSupplied",
      oracle: "blend.oracle.isFresh",
    },
    thresholds: [{ name: "max_utilization", type: "fixed_1e6" }],
    predicate: (f, t) => {
      const denom = f.supplied === 0n ? 1n : f.supplied;
      const utilization = (f.borrowed * ZK_SCALE) / denom;
      return utilization < t.max_utilization && f.oracle === 1n;
    },
  },
  "aquarius-route-policy": {
    slots: {
      estimated_out: "aquarius.estimatedOut",
      route_hops: "aquarius.routeHops",
    },
    thresholds: [{ name: "min_out", type: "u128" }],
    predicate: (f, t) => f.estimated_out >= t.min_out && f.route_hops <= 4n,
  },
  "sdex-exit-policy": {
    slots: {
      path_available: "sdex.pathAvailable",
      path_estimated_out: "sdex.pathEstimatedOut",
      spread_bps: "sdex.spreadBps",
    },
    thresholds: [
      { name: "min_receive", type: "u128" },
      { name: "max_spread_bps", type: "u64" },
    ],
    predicate: (f, t) => {
      const pathOk = f.path_estimated_out >= t.min_receive;
      const spreadOk = f.spread_bps <= t.max_spread_bps;
      return f.path_available === 1n && (pathOk || spreadOk);
    },
  },
  "composite-borrow-exit-policy": {
    slots: {
      health: "blend.healthAfterAction",
      estimated_out: "aquarius.estimatedOut",
      route_hops: "aquarius.routeHops",
      path_available: "sdex.pathAvailable",
      path_estimated_out: "sdex.pathEstimatedOut",
    },
    thresholds: [
      { name: "min_health", type: "fixed_1e6" },
      { name: "min_receive", type: "u128" },
    ],
    predicate: (f, t) => {
      const blendSafe = f.health > t.min_health;
      const aquaExit = f.estimated_out >= t.min_receive && f.route_hops <= 4n;
      const sdexExit = f.path_available === 1n && f.path_estimated_out >= t.min_receive;
      return blendSafe && (aquaExit || sdexExit);
    },
  },
};

export function recipeSpec(recipe: string): RecipeSpec {
  const spec = RECIPE_SPECS[recipe];
  if (!spec) throw new Error(`SEFI_BN254_NO_CIRCUIT: no witness spec for recipe "${recipe}"`);
  return spec;
}

function normalizeThreshold(spec: ThresholdSpec, raw: unknown): bigint {
  const s = String(raw).trim();
  if (spec.type === "fixed_1e6") {
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`threshold ${spec.name} not numeric: ${s}`);
    const neg = s.startsWith("-");
    const [i, frac = ""] = s.replace("-", "").split(".");
    const scaled = BigInt(i) * ZK_SCALE + BigInt((frac + "000000").slice(0, 6) || "0");
    return neg ? -scaled : scaled;
  }
  if (!/^-?\d+$/.test(s)) {
    if (/^-?\d+\.\d+$/.test(s)) return BigInt(s.split(".")[0]); // floor
    throw new Error(`threshold ${spec.name} not integer: ${s}`);
  }
  return BigInt(s);
}

export interface BuildWitnessInput {
  recipe: string;
  compiled: CompiledComputeIntent;
  capsule: ContextCapsule;
  facts: SemanticFact[];
  evaluation: ComputeEvaluation;
  privateInputs: Record<string, unknown>;
}

/** Build the complete circuit witness for a recipe. Throws if any bound fact is missing. */
export function buildWitness(input: BuildWitnessInput): CircuitWitness {
  const spec = recipeSpec(input.recipe);
  const tree = buildFixedTree(input.facts.map(hashFactToFr));

  const factWitnesses: FactWitness[] = [];
  for (const [slot, variable] of Object.entries(spec.slots)) {
    const binding = input.compiled.factRefs.find((b) => b.variable === variable);
    if (!binding)
      throw new Error(`SEFI_BN254_WITNESS_MISSING_BINDING: ${variable} not bound by compiled intent`);
    const index = input.facts.findIndex((f) => f.id === binding.factId);
    if (index < 0)
      throw new Error(`SEFI_BN254_WITNESS_FACT_NOT_IN_CAPSULE: ${variable} (${binding.factId})`);
    const fact = input.facts[index];
    const proof = fixedTreeProof(tree, index);
    factWitnesses.push({
      slot,
      variable,
      value: factValueToFr(fact),
      pathId: BigInt(factPathId(fact)),
      adapterHash: bytes32ToFr(fact.adapterHash),
      ledgerSeq: BigInt(fact.ledgerSeq ?? 0),
      siblings: proof.siblings,
      bits: proof.bits,
    });
  }

  const thresholds: Record<string, bigint> = {};
  for (const t of spec.thresholds) {
    // Thresholds map to the DSL private input names by convention (see recipes).
    const dslName = THRESHOLD_TO_DSL[input.recipe]?.[t.name] ?? t.name;
    if (!(dslName in input.privateInputs))
      throw new Error(`SEFI_BN254_WITNESS_MISSING_THRESHOLD: private.${dslName}`);
    thresholds[t.name] = normalizeThreshold(t, input.privateInputs[dslName]);
  }

  const revealed = referenceEvaluate(input.recipe, factWitnesses, thresholds, {
    zkContextRoot: bytes32ToFr(input.capsule.zkContextRoot ?? "0x0"),
    zkFactsRoot: bytes32ToFr(input.capsule.zkFactsRoot ?? "0x0"),
    sourceRoot: bytes32ToFr(input.capsule.sourceRoot),
    adapterSetHash: bytes32ToFr(input.capsule.adapterSetHash),
  });

  return {
    recipe: input.recipe,
    public: {
      zkContextRoot: bytes32ToFr(input.capsule.zkContextRoot ?? "0x0"),
      zkFactsRoot: bytes32ToFr(input.capsule.zkFactsRoot ?? "0x0"),
      computeHash: bytes32ToFr(input.compiled.computeHash),
      resultHash: bytes32ToFr(input.evaluation.resultHash),
      sourceRoot: bytes32ToFr(input.capsule.sourceRoot),
      adapterSetHash: bytes32ToFr(input.capsule.adapterSetHash),
    },
    facts: factWitnesses,
    thresholds,
    revealed: revealed.result,
  };
}

/** Maps circuit threshold names to the DSL private-input names used in recipes. */
const THRESHOLD_TO_DSL: Record<string, Record<string, string>> = {
  "blend-utilization-policy": { max_utilization: "maxUtilization" },
  "aquarius-route-policy": { min_out: "minOut" },
  "sdex-exit-policy": { min_receive: "minReceive", max_spread_bps: "maxSpreadBps" },
  "composite-borrow-exit-policy": { min_health: "minHealth", min_receive: "minReceive" },
};

/**
 * Reference circuit evaluator — mirrors the Noir circuit EXACTLY:
 *  1. recompute zkContextRoot = Poseidon3(zkFactsRoot, sourceRoot, adapterSetHash)
 *     and assert it equals the public zkContextRoot;
 *  2. recompute each fact leaf = Poseidon4(pathId, value, adapterHash, ledgerSeq)
 *     and verify its Merkle path against zkFactsRoot;
 *  3. apply the recipe predicate.
 * Returns the boolean result + all intermediate checks (used by tests + to
 * confirm `nargo execute` would succeed).
 */
export function referenceEvaluate(
  recipe: string,
  facts: FactWitness[],
  thresholds: Record<string, bigint>,
  roots: { zkContextRoot: bigint; zkFactsRoot: bigint; sourceRoot: bigint; adapterSetHash: bigint },
): { result: boolean; contextRootOk: boolean; merkleOk: boolean } {
  const spec = recipeSpec(recipe);

  const recomputedCtx = poseidon3([
    roots.zkFactsRoot % BN254_FR_MODULUS,
    roots.sourceRoot % BN254_FR_MODULUS,
    roots.adapterSetHash % BN254_FR_MODULUS,
  ]);
  const contextRootOk = recomputedCtx === roots.zkContextRoot;

  let merkleOk = true;
  const fieldValues: Record<string, bigint> = {};
  for (const f of facts) {
    const leaf = poseidon4([f.pathId, f.value % BN254_FR_MODULUS, f.adapterHash % BN254_FR_MODULUS, f.ledgerSeq]);
    let cur = leaf;
    for (let k = 0; k < f.siblings.length; k++) {
      cur = f.bits[k] === 0 ? poseidon2([cur, f.siblings[k]]) : poseidon2([f.siblings[k], cur]);
    }
    if (cur !== roots.zkFactsRoot) merkleOk = false;
    fieldValues[f.slot] = f.value;
  }

  if (!contextRootOk || !merkleOk) return { result: false, contextRootOk, merkleOk };
  return { result: spec.predicate(fieldValues, thresholds), contextRootOk, merkleOk };
}

function frDec(v: bigint): string {
  return (((v % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS).toString(10);
}

/**
 * Build the snarkjs/circom input object for a witness. Signal names match the
 * circom circuit (circuits/circom/*.circom): public roots, per-fact
 * value/pathId/adapter/ledger/path/bits, and the private thresholds.
 */
export function witnessToCircomInput(w: CircuitWitness): Record<string, string | string[]> {
  const dec = (v: bigint) => frDec(v);
  const input: Record<string, string | string[]> = {
    zkContextRoot: dec(w.public.zkContextRoot),
    zkFactsRoot: dec(w.public.zkFactsRoot),
    computeHash: dec(w.public.computeHash),
    resultHash: dec(w.public.resultHash),
    sourceRoot: dec(w.public.sourceRoot),
    adapterSetHash: dec(w.public.adapterSetHash),
  };
  for (const f of w.facts) {
    input[f.slot] = dec(f.value);
    input[`${f.slot}_path_id`] = dec(f.pathId);
    input[`${f.slot}_adapter`] = dec(f.adapterHash);
    input[`${f.slot}_ledger`] = dec(f.ledgerSeq);
    input[`${f.slot}_path`] = f.siblings.map(dec);
    input[`${f.slot}_bits`] = f.bits.map((b) => String(b));
  }
  for (const [name, value] of Object.entries(w.thresholds)) input[name] = dec(value);
  return input;
}

/** Serialise a witness to a Noir Prover.toml. Field names match the circuit's main(). */
export function witnessToToml(w: CircuitWitness): string {
  const L: string[] = [];
  L.push(`zk_context_root_pub = "${frDec(w.public.zkContextRoot)}"`);
  L.push(`zk_facts_root = "${frDec(w.public.zkFactsRoot)}"`);
  L.push(`compute_hash = "${frDec(w.public.computeHash)}"`);
  L.push(`result_hash = "${frDec(w.public.resultHash)}"`);
  L.push(`source_root = "${frDec(w.public.sourceRoot)}"`);
  L.push(`adapter_set_hash = "${frDec(w.public.adapterSetHash)}"`);
  for (const f of w.facts) {
    L.push(`${f.slot} = "${frDec(f.value)}"`);
    L.push(`${f.slot}_path_id = "${frDec(f.pathId)}"`);
    L.push(`${f.slot}_adapter = "${frDec(f.adapterHash)}"`);
    L.push(`${f.slot}_ledger = "${frDec(f.ledgerSeq)}"`);
    L.push(`${f.slot}_path = [${f.siblings.map((s) => `"${frDec(s)}"`).join(", ")}]`);
    L.push(`${f.slot}_bits = [${f.bits.join(", ")}]`);
  }
  for (const [name, value] of Object.entries(w.thresholds)) {
    L.push(`${name} = "${frDec(value)}"`);
  }
  return L.join("\n") + "\n";
}

export { ZK_MERKLE_DEPTH };
