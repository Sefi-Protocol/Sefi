import { randomUUID } from "node:crypto";
import type {
  Network,
  Protocol,
  SourceKind,
  SourceRecord,
} from "@sefi/shared-types";
import { hashResponse, hashXdr, sha256Hex, stableStringify } from "./hash.js";

export {
  stableStringify,
  sha256Hex,
  hashResponse,
  hashXdr,
  merkleRoot,
} from "./hash.js";

/**
 * Stable identity for an adapter version. Combining the adapter name + semver +
 * the source text hash means a code change invalidates the adapter hash, which
 * is what the proof-of-data layer keys on.
 */
export function computeAdapterHash(
  name: string,
  version: string,
  sourceText = "",
): string {
  return sha256Hex(`${name}@${version}\n${sourceText}`);
}

export interface BuildSourceRecordInput {
  network: Network;
  protocol: Protocol;
  sourceKind: SourceKind;
  endpoint?: string;
  contractId?: string;
  functionName?: string;
  argsXdr?: string;
  requestBody?: unknown;
  response: unknown;
  rawXdr?: string;
  ledgerSeq?: number;
  latestLedger?: number;
  adapterName: string;
  adapterVersion: string;
  adapterHash: string;
  fetchedAt?: string;
}

/**
 * Construct a fully-hashed {@link SourceRecord}. Every raw response captured by
 * an adapter must pass through here so that the hash discipline in spec §5 is
 * applied uniformly: canonical request hash, canonical response hash, optional
 * XDR hash, and the raw payload inlined for replay.
 */
export function buildSourceRecord(input: BuildSourceRecordInput): SourceRecord {
  const id = `src_${input.protocol}_${input.sourceKind}_${randomUUID().slice(0, 8)}`;
  const responseHash = input.rawXdr
    ? hashXdr(input.rawXdr)
    : hashResponse(input.response);
  const requestBodyHash = sha256Hex(
    stableStringify(input.requestBody ?? {}),
  );
  return {
    id,
    network: input.network,
    protocol: input.protocol,
    sourceKind: input.sourceKind,
    endpoint: input.endpoint,
    contractId: input.contractId,
    functionName: input.functionName,
    argsXdr: input.argsXdr,
    requestBodyHash,
    responseHash,
    rawResponseRef: id,
    rawResponse: input.response,
    rawXdr: input.rawXdr,
    ledgerSeq: input.ledgerSeq,
    latestLedger: input.latestLedger,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    adapterName: input.adapterName,
    adapterVersion: input.adapterVersion,
    adapterHash: input.adapterHash,
  };
}

/** Recompute the response hash of a stored record (used by replay/verify). */
export function recomputeResponseHash(record: SourceRecord): string {
  return record.rawXdr
    ? hashXdr(record.rawXdr)
    : hashResponse(record.rawResponse);
}
