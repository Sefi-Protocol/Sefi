import type {
  ContextCapsule,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import type { FactQuery, SefiStore } from "./types.js";

/**
 * Zero-dependency in-memory store. Backs unit tests, the on-demand MVP path
 * (spec §4.2) and any environment without PostgreSQL. Same semantics as
 * {@link PgStore} so adapters/API are storage-agnostic.
 */
export class MemoryStore implements SefiStore {
  private sources = new Map<string, SourceRecord>();
  private facts = new Map<string, SemanticFact>();
  private capsules = new Map<string, ContextCapsule>();

  async saveSourceRecords(records: SourceRecord[]): Promise<void> {
    for (const r of records) this.sources.set(r.id, r);
  }
  async saveFacts(facts: SemanticFact[]): Promise<void> {
    for (const f of facts) this.facts.set(f.id, f);
  }
  async saveCapsule(capsule: ContextCapsule): Promise<void> {
    this.capsules.set(capsule.id, capsule);
  }

  async getSourceRecord(id: string): Promise<SourceRecord | null> {
    return this.sources.get(id) ?? null;
  }
  async getFact(id: string): Promise<SemanticFact | null> {
    return this.facts.get(id) ?? null;
  }
  async getCapsule(id: string): Promise<ContextCapsule | null> {
    return this.capsules.get(id) ?? null;
  }

  async queryFacts(query: FactQuery): Promise<SemanticFact[]> {
    let out = [...this.facts.values()];
    if (query.network) out = out.filter((f) => f.network === query.network);
    if (query.protocol) out = out.filter((f) => f.protocol === query.protocol);
    if (query.entityType)
      out = out.filter((f) => f.entityType === query.entityType);
    if (query.entityId) out = out.filter((f) => f.entityId === query.entityId);
    if (query.field) out = out.filter((f) => f.field === query.field);
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return query.limit ? out.slice(0, query.limit) : out;
  }

  async getCapsuleSourceRecords(capsuleId: string): Promise<SourceRecord[]> {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) return [];
    return capsule.sourceRecordIds
      .map((id) => this.sources.get(id))
      .filter((r): r is SourceRecord => Boolean(r));
  }
  async getCapsuleFacts(capsuleId: string): Promise<SemanticFact[]> {
    const capsule = this.capsules.get(capsuleId);
    if (!capsule) return [];
    return capsule.semanticFactIds
      .map((id) => this.facts.get(id))
      .filter((f): f is SemanticFact => Boolean(f));
  }

  async deleteCapsulesOlderThan(beforeIso: string): Promise<number> {
    let n = 0;
    for (const [id, c] of this.capsules) {
      if (c.createdAt < beforeIso) {
        this.capsules.delete(id);
        n++;
      }
    }
    return n;
  }
}
