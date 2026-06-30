import { randomUUID } from "node:crypto";
import type {
  Confidence,
  EntityType,
  Network,
  Protocol,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";

export interface FactInput<T = unknown> {
  network: Network;
  protocol: Protocol;
  entityType: EntityType;
  entityId: string;
  field: string;
  value: T;
  unit?: string;
  confidence?: Confidence;
  ledgerSeq?: number;
  /** Source records this fact was decoded from. */
  sources: SourceRecord[];
}

/**
 * Build a source-backed {@link SemanticFact} (spec §6.4). Every fact carries the
 * ids + combined raw hash + adapter hash of the source records it derives from,
 * so the chain `fact → source record → raw response hash → ledger` (spec §5.3)
 * is always reconstructable.
 */
export function buildFact<T>(input: FactInput<T>): SemanticFact<T> {
  const sources = input.sources;
  const sourceRecordIds = sources.map((s) => s.id);
  const rawHash = sources.map((s) => s.responseHash).join(",");
  const adapterHash = sources[0]?.adapterHash ?? "0x";
  const ledgerSeq =
    input.ledgerSeq ??
    sources.map((s) => s.ledgerSeq).find((l) => typeof l === "number");
  return {
    id: `fact_${input.protocol}_${slug(input.field)}_${randomUUID().slice(0, 8)}`,
    network: input.network,
    protocol: input.protocol,
    entityType: input.entityType,
    entityId: input.entityId,
    field: input.field,
    value: input.value,
    unit: input.unit,
    ledgerSeq,
    sourceRecordIds,
    rawHash,
    adapterHash,
    confidence: input.confidence ?? "high",
    createdAt: new Date().toISOString(),
  };
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
}

/**
 * Confidence heuristic following spec §21.1. `freshLedger` means the source had
 * a usable ledger sequence; `kind` selects the base tier.
 */
export function confidenceFor(opts: {
  kind: "rpc_getter" | "horizon" | "protocol_api";
  hasLedger: boolean;
  stale?: boolean;
  conflicting?: boolean;
}): Confidence {
  if (opts.conflicting || opts.stale) return "low";
  if (!opts.hasLedger) return "low";
  if (opts.kind === "rpc_getter") return "high";
  if (opts.kind === "horizon") return "medium";
  return "medium";
}
