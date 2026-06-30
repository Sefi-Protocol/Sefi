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
  sourceRootField: bigint;
  adapterHashField: bigint;
  ledgerSeq: number;
}

/**
 * Convert a fact value to a field element. Booleans -> 0/1, enum freshness ->
 * 0/1, numeric strings/decimals -> integer field (decimals floored), other
 * strings -> reduced sha-of-canonical-fact field.
 */
export function factValueToFr(fact: SemanticFact): bigint {
  const v = fact.value;
  if (typeof v === "boolean") return v ? 1n : 0n;
  if (typeof v === "number") return BigInt(Math.trunc(v)) % BN254_FR_MODULUS;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "fresh" || s === "true") return 1n;
    if (s === "stale" || s === "unknown" || s === "false") return 0n;
    if (/^-?\d+$/.test(s)) return ((BigInt(s) % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS;
    if (/^-?\d+\.\d+$/.test(s)) {
      const neg = s.startsWith("-");
      const intPart = BigInt(s.replace("-", "").split(".")[0]);
      const val = neg ? -intPart : intPart;
      return ((val % BN254_FR_MODULUS) + BN254_FR_MODULUS) % BN254_FR_MODULUS;
    }
  }
  // Fallback: bind the exact canonical fact hash as the value field.
  return bytes32ToFr(hashSemanticFact(fact));
}

/** Build the field-level leaf for a fact. */
export function zkFactLeaf(fact: SemanticFact): ZkFactLeaf {
  const sourceRootField = bytes32ToFr(
    hashSemanticFact(fact), // per-fact source binding (canonical fact hash)
  );
  return {
    pathId: factPathId(fact),
    valueField: factValueToFr(fact),
    sourceRootField,
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

/** Poseidon Merkle root over sorted leaf hashes (duplicate-last for odd nodes). */
export function poseidonMerkleRoot(leaves: bigint[]): bigint {
  if (leaves.length === 0) return 0n;
  let level = [...leaves].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(poseidon2([l, r]));
    }
    level = next;
  }
  return level[0];
}

function frToHex(v: bigint): `0x${string}` {
  return ("0x" + (v % BN254_FR_MODULUS).toString(16).padStart(64, "0")) as `0x${string}`;
}

/** zkFactsRoot = Poseidon Merkle root over fact leaf hashes, hex-encoded. */
export function zkFactsRootFr(facts: SemanticFact[]): bigint {
  return poseidonMerkleRoot(facts.map(hashFactToFr));
}
export function zkFactsRootHex(facts: SemanticFact[]): `0x${string}` {
  return frToHex(zkFactsRootFr(facts));
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
