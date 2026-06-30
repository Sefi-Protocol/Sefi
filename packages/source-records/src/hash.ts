import { createHash } from "node:crypto";

/**
 * Deterministic JSON serialisation: object keys are sorted recursively so that
 * two semantically-equal responses always produce the same bytes. This is the
 * canonicalisation step required before hashing (spec §5.2).
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  // bigint is not JSON-serialisable; render as decimal string deterministically.
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return "0x" + createHash("sha256").update(input).digest("hex");
}

/** Hash a (canonicalised) JSON response. */
export function hashResponse(response: unknown): string {
  return sha256Hex(stableStringify(response));
}

/** Hash a base64 XDR string verbatim (spec §5.2). */
export function hashXdr(base64Xdr: string): string {
  return sha256Hex(base64Xdr);
}

/**
 * Merkle root over a set of leaf hashes. Leaves are sorted first so the root is
 * order-independent (spec §5.2: `merkle_root(sorted(source_record_hashes))`).
 * Hashes use the "0x"-prefixed hex convention from sha256Hex. An odd node is
 * promoted (duplicated) to the next level. Empty input yields sha256("").
 */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) return sha256Hex("");
  let level = [...leafHashes].sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}

export interface MerkleProofParts {
  leaf: string;
  leafIndex: number;
  siblings: string[];
  root: string;
}

/**
 * Build a Merkle inclusion proof for `leaf` within `leafHashes`, using the same
 * sorted-leaves + duplicate-last construction as {@link merkleRoot}. Returns the
 * sibling path (bottom-up) so a verifier can recompute the root.
 */
export function merkleProof(
  leafHashes: string[],
  leaf: string,
): MerkleProofParts | null {
  if (leafHashes.length === 0) return null;
  const sorted = [...leafHashes].sort();
  let index = sorted.indexOf(leaf);
  if (index < 0) return null;
  const leafIndex = index;
  const siblings: string[] = [];
  let level = sorted;
  while (level.length > 1) {
    const isRight = index % 2 === 1;
    const pairIndex = isRight ? index - 1 : index + 1;
    const sibling = pairIndex < level.length ? level[pairIndex] : level[index];
    siblings.push(sibling);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256Hex(left + right));
    }
    level = next;
    index = Math.floor(index / 2);
  }
  return { leaf, leafIndex, siblings, root: level[0] };
}

/** Verify a Merkle inclusion proof produced by {@link merkleProof}. */
export function verifyMerkleProof(proof: {
  leaf: string;
  leafIndex: number;
  siblings: string[];
  root: string;
}): boolean {
  let hash = proof.leaf;
  let index = proof.leafIndex;
  for (const sibling of proof.siblings) {
    const isRight = index % 2 === 1;
    hash = isRight ? sha256Hex(sibling + hash) : sha256Hex(hash + sibling);
    index = Math.floor(index / 2);
  }
  return hash === proof.root;
}
