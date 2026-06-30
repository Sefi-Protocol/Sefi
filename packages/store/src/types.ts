import type {
  CompiledComputeIntent,
  ContextCapsule,
  ProofCard,
  ProofEnvelope,
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

export interface IngestionCheckpoint {
  /** worker:protocol:contract */
  id: string;
  worker: string;
  protocol: string;
  contractId?: string;
  cursor?: string;
  latestLedger?: number;
  updatedAt: string;
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

  // Phase 2 — compute / proof persistence (spec §18).
  saveComputeIntent(intent: CompiledComputeIntent): Promise<void>;
  getComputeIntent(id: string): Promise<CompiledComputeIntent | null>;
  saveProofEnvelope(envelope: ProofEnvelope, computeIntentId?: string): Promise<void>;
  getProofEnvelope(id: string): Promise<ProofEnvelope | null>;
  /** Resolve the compiled intent linked to a proof envelope (audit Part E §4). */
  getComputeIntentByProof(proofId: string): Promise<CompiledComputeIntent | null>;

  // Phase 1 reliability — worker ingestion checkpoints (audit Part J §1).
  saveCheckpoint(checkpoint: IngestionCheckpoint): Promise<void>;
  getCheckpoint(id: string): Promise<IngestionCheckpoint | null>;
  saveProofCard(card: ProofCard, proofEnvelopeId: string): Promise<void>;
  getProofCard(proofId: string): Promise<ProofCard | null>;

  init?(): Promise<void>;
  close?(): Promise<void>;
}
