/**
 * ZK-friendly fact commitments over BN254 (audit Part C). The SHA-256
 * `semanticFactsRoot` is the off-chain replay commitment; this module adds a
 * **field-friendly** root over the BN254 scalar field using Poseidon, suitable
 * for in-circuit verification by the Noir/BN254 proof path.
 *
 * Poseidon is provided by `poseidon-lite` (the circomlib BN254 Poseidon). The
 * Noir circuits MUST use a matching Poseidon instantiation; that cross-check is
 * verified by the Noir test fixtures (see circuits/shared) on a machine with the
 * toolchain installed. The TS reference here is deterministic and golden-tested.
 */
import { poseidon2, poseidon3, poseidon4 } from "poseidon-lite";
import type { SemanticFact } from "@sefi/shared-types";
import { hashSemanticFact } from "./index.js";

/** BN254 scalar field (Fr) modulus. */
export const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Reduce a 0x-prefixed (or raw) 32-byte hex string to a BN254 Fr element. */
export function bytes32ToFr(hex32: string): bigint {
  const clean = hex32.startsWith("0x") ? hex32.slice(2) : hex32;
  if (!/^[0-9a-fA-F]+$/.test(clean)) throw new Error(`bytes32ToFr: not hex: ${hex32}`);
  const v = BigInt("0x" + clean);
  return v % BN254_FR_MODULUS;
}

/** Stable numeric registry of supported fact paths (audit Part C §3). */
export const FACT_PATH_IDS: Record<string, number> = {
  "blend.reserve.USDC.totalBorrowed": 1001,
  "blend.reserve.USDC.totalSupplied": 1002,
  "blend.oracle.isFresh": 1003,
  "blend.healthAfterAction": 1004,
  "aquarius.estimatedOut": 2001,
  "aquarius.routeHops": 2002,
  "aquarius.routeAvailable": 2003,
  "sdex.pathAvailable": 3001,
  "sdex.pathEstimatedOut": 3002,
  "sdex.spreadBps": 3003,
};

/** Map a semantic fact to its registered pathId, or 0 if unregistered. */
export function factPathId(fact: SemanticFact): number {
  // Reserve facts: blend reserve.<metric> keyed by symbol in entityId.
  if (fact.protocol === "blend" && fact.entityType === "reserve") {
    const sym = fact.entityId.split(":").pop();
    const key =
      fact.field === "reserve.totalBorrowed"
        ? `blend.reserve.${sym}.totalBorrowed`
        : fact.field === "reserve.totalSupplied"
          ? `blend.reserve.${sym}.totalSupplied`
          : "";
    return FACT_PATH_IDS[key] ?? 0;
  }
  const byField: Record<string, string> = {
    "oracle.freshness": "blend.oracle.isFresh",
    "health.factor": "blend.healthAfterAction",
    "slippage.estimated_out": "aquarius.estimatedOut",
    "route.hops": "aquarius.routeHops",
    "route.available": "aquarius.routeAvailable",
    "path.available": "sdex.pathAvailable",
    "path.estimated_out": "sdex.pathEstimatedOut",
    "market.spread_bps": "sdex.spreadBps",
  };
  const key = byField[fact.field];
  if (!key) return 0;
  // Disambiguate aquarius vs sdex by protocol.
  if (key.startsWith("aquarius.") && fact.protocol !== "aquarius") return 0;
  if (key.startsWith("sdex.") && fact.protocol !== "stellar_dex") return 0;
  return FACT_PATH_IDS[key] ?? 0;
}

export interface ZkFactLeaf {
  pathId: number;
  valueField: bigint;
  adapterHashField: bigint;
  ledgerSeq: number;
}

/** Scale of the field-domain fixed-point representation (matches @sefi/compute SCALE). */
export const ZK_SCALE = 1_000_000n;

/**
 * Fields whose values are ratios represented as 1e6 fixed point. This set MUST
 * match the `fixed_1e6` valueTypes used by the compute bindings, so the value
 * committed in the zk leaf equals the value the circuit predicate compares
 * against (and the value the off-chain evaluator normalizes to).
 */
export const FIXED_1E6_FIELDS = new Set<string>([
  "pool.utilization",
  "health.factor",
  "market.best_bid",
  "market.best_ask",
]);

function decimalToScaled(s: string): bigint {
  const neg = s.startsWith("-");
  const [intPart, fracPart = ""] = s.replace("-", "").split(".");
  const frac = (fracPart + "000000").slice(0, 6);
  const scaled = BigInt(intPart) * ZK_SCALE + BigInt(frac || "0");
  return neg ? -scaled : scaled;
}

function mod(v: bigint): bigint {
  return ((v % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS;
}

/**
 * Convert a fact value to a field element, using the SAME normalization the
 * compute evaluator + Noir circuit use:
 *  - booleans / enum freshness -> 0 or 1,
 *  - `fixed_1e6` ratio fields -> value * 1e6 (e.g. "0.84" -> 840000),
 *  - integer / decimal numeric values -> integer field (decimals floored),
 *  - anything else -> the canonical fact hash reduced to Fr.
 * This guarantees the Merkle-committed leaf value equals the predicate input.
 */
export function factValueToFr(fact: SemanticFact): bigint {
  const v = fact.value;
  if (typeof v === "boolean") return v ? 1n : 0n;
  const fixed = FIXED_1E6_FIELDS.has(fact.field);
  if (typeof v === "number") {
    return fixed ? mod(decimalToScaled(String(v))) : mod(BigInt(Math.trunc(v)));
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "fresh" || s === "true") return 1n;
    if (s === "stale" || s === "unknown" || s === "false") return 0n;
    if (fixed && /^-?\d+(\.\d+)?$/.test(s)) return mod(decimalToScaled(s));
    if (/^-?\d+$/.test(s)) return mod(BigInt(s));
    if (/^-?\d+\.\d+$/.test(s)) {
      const intPart = BigInt(s.replace("-", "").split(".")[0]);
      return mod(s.startsWith("-") ? -intPart : intPart);
    }
  }
  return bytes32ToFr(hashSemanticFact(fact));
}

/** Build the field-level leaf for a fact. */
export function zkFactLeaf(fact: SemanticFact): ZkFactLeaf {
  return {
    pathId: factPathId(fact),
    valueField: factValueToFr(fact),
    adapterHashField: bytes32ToFr(fact.adapterHash),
    ledgerSeq: fact.ledgerSeq ?? 0,
  };
}

/** Poseidon hash of a zk fact leaf: H(pathId, value, adapterHash, ledgerSeq). */
export function zkFactLeafHash(leaf: ZkFactLeaf): bigint {
  return poseidon4([
    BigInt(leaf.pathId),
    leaf.valueField % BN254_FR_MODULUS,
    leaf.adapterHashField % BN254_FR_MODULUS,
    BigInt(leaf.ledgerSeq),
  ]);
}

export function hashFactToFr(fact: SemanticFact): bigint {
  return zkFactLeafHash(zkFactLeaf(fact));
}

/**
 * Fixed Merkle depth shared by the TS reference and the Noir circuits
 * (`circuits/shared/src/lib.nr` `MERKLE_DEPTH`). A depth-8 tree holds up to 256
 * facts per capsule; leaves are placed in insertion order and empty slots use
 * the zero leaf. The tree is computed sparsely (only the populated path is
 * hashed) so it is cheap while producing the exact root a full 2^depth tree
 * over the zero-padded leaves would produce.
 */
export const ZK_MERKLE_DEPTH = 8;
export const ZK_ZERO_LEAF = 0n;

/** Precompute the all-empty subtree root at each level (level 0 = ZK_ZERO_LEAF). */
function emptySubtreeRoots(depth: number): bigint[] {
  const empty: bigint[] = [ZK_ZERO_LEAF];
  for (let k = 1; k <= depth; k++) empty[k] = poseidon2([empty[k - 1], empty[k - 1]]);
  return empty;
}

interface FixedTree {
  root: bigint;
  levels: bigint[][]; // populated prefix at each level (level 0 = leaves)
  empty: bigint[];
  depth: number;
}

/** Build a fixed-depth sparse Merkle tree over `leaves` (insertion order). */
export function buildFixedTree(leaves: bigint[], depth = ZK_MERKLE_DEPTH): FixedTree {
  if (leaves.length > 2 ** depth)
    throw new Error(`zk merkle: ${leaves.length} leaves exceed depth ${depth} capacity (${2 ** depth})`);
  const empty = emptySubtreeRoots(depth);
  const levels: bigint[][] = [leaves.length ? leaves.slice() : [ZK_ZERO_LEAF]];
  for (let k = 0; k < depth; k++) {
    const cur = levels[k];
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const l = cur[i] ?? empty[k];
      const r = i + 1 < cur.length ? cur[i + 1] : empty[k];
      next.push(poseidon2([l, r]));
    }
    levels.push(next.length ? next : [empty[k + 1]]);
  }
  return { root: levels[depth][0], levels, empty, depth };
}

export interface ZkMerkleProof {
  leaf: bigint;
  leafIndex: number;
  siblings: bigint[]; // length depth, bottom-up
  bits: number[]; // length depth, 0 = current is left child
  root: bigint;
}

/** Inclusion proof for the leaf at `index` in a fixed-depth tree. */
export function fixedTreeProof(tree: FixedTree, index: number): ZkMerkleProof {
  const siblings: bigint[] = [];
  const bits: number[] = [];
  let idx = index;
  for (let k = 0; k < tree.depth; k++) {
    const level = tree.levels[k];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    const sibling = sibIdx < level.length ? level[sibIdx] : tree.empty[k];
    siblings.push(sibling);
    bits.push(isRight ? 1 : 0);
    idx = Math.floor(idx / 2);
  }
  return { leaf: tree.levels[0][index] ?? ZK_ZERO_LEAF, leafIndex: index, siblings, bits, root: tree.root };
}

/** Verify a fixed-depth inclusion proof (mirrors the circuit's verify_merkle_path). */
export function verifyZkMerkleProof(proof: ZkMerkleProof): boolean {
  let cur = proof.leaf;
  for (let k = 0; k < proof.siblings.length; k++) {
    cur = proof.bits[k] === 0 ? poseidon2([cur, proof.siblings[k]]) : poseidon2([proof.siblings[k], cur]);
  }
  return cur === proof.root;
}

function frToHex(v: bigint): `0x${string}` {
  return ("0x" + (((v % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS).toString(16).padStart(64, "0")) as `0x${string}`;
}

/** zkFactsRoot = fixed-depth Poseidon Merkle root over fact leaf hashes. */
export function zkFactsRootFr(facts: SemanticFact[]): bigint {
  return buildFixedTree(facts.map(hashFactToFr)).root;
}
export function zkFactsRootHex(facts: SemanticFact[]): `0x${string}` {
  return frToHex(zkFactsRootFr(facts));
}

/** Build the inclusion proof for the fact at `index` within `facts`. */
export function zkFactMerkleProof(facts: SemanticFact[], index: number): ZkMerkleProof {
  return fixedTreeProof(buildFixedTree(facts.map(hashFactToFr)), index);
}

/**
 * zkContextRoot = Poseidon(zkFactsRoot, sourceRootFr, adapterSetHashFr).
 * `computeHashFr` is bound at proof time as a circuit public input.
 */
export function zkContextRootFr(input: {
  zkFactsRoot: bigint;
  sourceRootHex: string;
  adapterSetHashHex: string;
}): bigint {
  return poseidon3([
    input.zkFactsRoot % BN254_FR_MODULUS,
    bytes32ToFr(input.sourceRootHex),
    bytes32ToFr(input.adapterSetHashHex),
  ]);
}
export function zkContextRootHex(input: {
  zkFactsRoot: bigint;
  sourceRootHex: string;
  adapterSetHashHex: string;
}): `0x${string}` {
  return frToHex(zkContextRootFr(input));
}

export { frToHex };

/** Re-export the Poseidon primitives so other packages don't depend on poseidon-lite directly. */
export const poseidonHash2 = (a: bigint, b: bigint): bigint => poseidon2([a, b]);
export const poseidonHash3 = (a: bigint, b: bigint, c: bigint): bigint => poseidon3([a, b, c]);
export const poseidonHash4 = (a: bigint, b: bigint, c: bigint, d: bigint): bigint =>
  poseidon4([a, b, c, d]);
