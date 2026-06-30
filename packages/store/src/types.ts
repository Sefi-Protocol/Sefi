import type {
  ContextCapsule,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";

export interface FactQuery {
  network?: string;
  protocol?: string;
  entityType?: string;
  entityId?: string;
  field?: string;
  limit?: number;
}

/**
 * Persistence contract used by adapters, the API and workers. Implemented by
 * {@link MemoryStore} (no deps, for tests/MVP/on-demand) and {@link PgStore}
 * (PostgreSQL, the canonical store per spec §4.4).
 */
export interface SefiStore {
  saveSourceRecords(records: SourceRecord[]): Promise<void>;
  saveFacts(facts: SemanticFact[]): Promise<void>;
  saveCapsule(capsule: ContextCapsule): Promise<void>;

  getSourceRecord(id: string): Promise<SourceRecord | null>;
  getFact(id: string): Promise<SemanticFact | null>;
  getCapsule(id: string): Promise<ContextCapsule | null>;

  queryFacts(query: FactQuery): Promise<SemanticFact[]>;
  /** Source records referenced by a capsule (for replay). */
  getCapsuleSourceRecords(capsuleId: string): Promise<SourceRecord[]>;
  getCapsuleFacts(capsuleId: string): Promise<SemanticFact[]>;

  /** Delete capsules created before `beforeIso`; returns count removed (cleanup worker). */
  deleteCapsulesOlderThan(beforeIso: string): Promise<number>;

  init?(): Promise<void>;
  close?(): Promise<void>;
}
