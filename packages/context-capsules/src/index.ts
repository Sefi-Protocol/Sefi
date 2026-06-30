import { randomUUID } from "node:crypto";
import type {
  CapsuleRoots,
  CompositeContext,
  ContextCapsule,
  Network,
  Protocol,
  ProtocolContext,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import { merkleRoot, sha256Hex } from "@sefi/source-records";

/** sourceRoot = merkle_root(sorted(source response hashes)) (spec §5.2). */
export function sourceRoot(sources: SourceRecord[]): string {
  return merkleRoot(sources.map((s) => s.responseHash));
}

/** factsRoot = merkle_root(sorted(fact raw hashes)). */
export function factsRoot(facts: SemanticFact[]): string {
  return merkleRoot(facts.map((f) => f.rawHash));
}

/** adapterSetHash binds the exact adapter versions that produced the context. */
export function adapterSetHash(sources: SourceRecord[]): string {
  const set = [...new Set(sources.map((s) => s.adapterHash))].sort();
  return sha256Hex(set.join("|"));
}

/**
 * compositeRoot = H(sourceRoot || factsRoot || adapterSetHash). This single
 * value is the future ZK public input (spec §12.4 / §25).
 */
export function compositeRoot(roots: {
  sourceRoot: string;
  factsRoot: string;
  adapterSetHash: string;
}): string {
  return sha256Hex(
    `${roots.sourceRoot}|${roots.factsRoot}|${roots.adapterSetHash}`,
  );
}

function ledgerRange(sources: SourceRecord[]) {
  const seqs = sources
    .map((s) => s.ledgerSeq)
    .filter((s): s is number => typeof s === "number");
  if (seqs.length === 0) return undefined;
  return { minLedger: Math.min(...seqs), maxLedger: Math.max(...seqs) };
}

export interface BuildCapsuleInput {
  network: Network;
  protocols: Protocol[];
  facts: SemanticFact[];
  sourceRecords: SourceRecord[];
}

/** Anything that can persist a capsule (the store satisfies this). */
export interface CapsuleSink {
  saveCapsule(capsule: ContextCapsule): Promise<void>;
}

/**
 * Build a capsule and persist it through `sink` if provided. Used by every
 * adapter's ask() so single-protocol answers also leave a capsule + roots
 * behind (spec §25), not just the composite path.
 */
export async function buildAndSaveCapsule(
  input: BuildCapsuleInput,
  sink?: CapsuleSink,
): Promise<ContextCapsule> {
  const capsule = buildCapsule(input);
  if (sink) await sink.saveCapsule(capsule);
  return capsule;
}

/**
 * Build a {@link ContextCapsule} (spec §12.3). Computes all three roots plus the
 * adapter-set hash and ledger range. `capsuleType` is derived from the number
 * of distinct protocols.
 */
export function buildCapsule(input: BuildCapsuleInput): ContextCapsule {
  const sRoot = sourceRoot(input.sourceRecords);
  const fRoot = factsRoot(input.facts);
  const aHash = adapterSetHash(input.sourceRecords);
  const distinct = [...new Set(input.protocols)];
  return {
    id: `capsule_${randomUUID().slice(0, 12)}`,
    capsuleType: distinct.length > 1 ? "multi_protocol" : "single_protocol",
    network: input.network,
    protocols: distinct,
    sourceRecordIds: input.sourceRecords.map((s) => s.id),
    semanticFactIds: input.facts.map((f) => f.id),
    sourceRoot: sRoot,
    factsRoot: fRoot,
    adapterSetHash: aHash,
    compositeRoot: compositeRoot({
      sourceRoot: sRoot,
      factsRoot: fRoot,
      adapterSetHash: aHash,
    }),
    ledgerRange: ledgerRange(input.sourceRecords),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Merge per-protocol contexts into a {@link CompositeContext} (spec §11.3) plus
 * its capsule. Facts and source records are de-duplicated by id.
 */
export function composeContexts(
  network: Network,
  contexts: ProtocolContext[],
): { composite: CompositeContext; capsule: ContextCapsule } {
  const factMap = new Map<string, SemanticFact>();
  const srcMap = new Map<string, SourceRecord>();
  const protocols: Protocol[] = [];
  for (const ctx of contexts) {
    protocols.push(ctx.protocol);
    for (const f of ctx.facts) factMap.set(f.id, f);
    for (const s of ctx.sourceRecords) srcMap.set(s.id, s);
  }
  const facts = [...factMap.values()];
  const sourceRecords = [...srcMap.values()];
  const capsule = buildCapsule({ network, protocols, facts, sourceRecords });
  const roots: CapsuleRoots = {
    sourceRoot: capsule.sourceRoot,
    factsRoot: capsule.factsRoot,
    compositeRoot: capsule.compositeRoot,
  };
  const composite: CompositeContext = {
    id: `ctx_${randomUUID().slice(0, 12)}`,
    network,
    protocols: [...new Set(protocols)],
    facts,
    sourceRecords,
    roots,
    capsuleId: capsule.id,
    createdAt: new Date().toISOString(),
  };
  return { composite, capsule };
}

/**
 * Replay verification (spec §20.4): recompute roots from the provided facts /
 * sources and confirm they match the stored capsule.
 */
export function verifyCapsule(
  capsule: ContextCapsule,
  facts: SemanticFact[],
  sources: SourceRecord[],
): { ok: boolean; sourceRootOk: boolean; factsRootOk: boolean; compositeRootOk: boolean } {
  const sRoot = sourceRoot(sources);
  const fRoot = factsRoot(facts);
  const aHash = adapterSetHash(sources);
  const cRoot = compositeRoot({
    sourceRoot: sRoot,
    factsRoot: fRoot,
    adapterSetHash: aHash,
  });
  const sourceRootOk = sRoot === capsule.sourceRoot;
  const factsRootOk = fRoot === capsule.factsRoot;
  const compositeRootOk = cRoot === capsule.compositeRoot;
  return {
    ok: sourceRootOk && factsRootOk && compositeRootOk,
    sourceRootOk,
    factsRootOk,
    compositeRootOk,
  };
}
