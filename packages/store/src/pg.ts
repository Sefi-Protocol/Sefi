import pg from "pg";
import type {
  CompiledComputeIntent,
  ContextCapsule,
  ProofCard,
  ProofEnvelope,
  SemanticFact,
  SourceRecord,
} from "@sefi/shared-types";
import type { FactQuery, IngestionCheckpoint, SefiStore } from "./types.js";

const { Pool } = pg;

/**
 * PostgreSQL-backed store (canonical store, spec §4.4 / §7). Tables are created
 * by services/postgres/migrations. JSONB columns hold raw responses and fact
 * values; the fact_sources / capsule_* join tables preserve provenance.
 */
export class PgStore implements SefiStore {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    // Connectivity probe; migrations are applied separately (idempotent).
    await this.pool.query("SELECT 1");
  }

  async saveSourceRecords(records: SourceRecord[]): Promise<void> {
    for (const r of records) {
      await this.pool.query(
        `INSERT INTO source_records
          (id, network, protocol, source_kind, endpoint, contract_id, function_name,
           args_xdr, request_hash, response_hash, raw_response, raw_xdr, ledger_seq,
           latest_ledger, fetched_at, adapter_name, adapter_version, adapter_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.network,
          r.protocol,
          r.sourceKind,
          r.endpoint ?? null,
          r.contractId ?? null,
          r.functionName ?? null,
          r.argsXdr ?? null,
          r.requestBodyHash,
          r.responseHash,
          JSON.stringify(r.rawResponse ?? null),
          r.rawXdr ?? null,
          r.ledgerSeq ?? null,
          r.latestLedger ?? null,
          r.fetchedAt,
          r.adapterName,
          r.adapterVersion,
          r.adapterHash,
        ],
      );
    }
  }

  async saveFacts(facts: SemanticFact[]): Promise<void> {
    for (const f of facts) {
      await this.pool.query(
        `INSERT INTO semantic_facts
          (id, network, protocol, entity_type, entity_id, field, value, unit,
           ledger_seq, raw_hash, adapter_hash, confidence, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [
          f.id,
          f.network,
          f.protocol,
          f.entityType,
          f.entityId,
          f.field,
          JSON.stringify(f.value),
          f.unit ?? null,
          f.ledgerSeq ?? null,
          f.rawHash,
          f.adapterHash,
          f.confidence,
          f.createdAt,
        ],
      );
      for (const srcId of f.sourceRecordIds) {
        await this.pool.query(
          `INSERT INTO fact_sources (fact_id, source_record_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [f.id, srcId],
        );
      }
    }
  }

  async saveCapsule(c: ContextCapsule): Promise<void> {
    await this.pool.query(
      `INSERT INTO context_capsules
        (id, capsule_type, network, protocols, source_root, facts_root,
         composite_root, semantic_facts_root, context_root, adapter_set_hash,
         zk_facts_root, zk_context_root, root_version, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        c.id,
        c.capsuleType,
        c.network,
        c.protocols,
        c.sourceRoot,
        c.factsRoot,
        c.compositeRoot,
        c.semanticFactsRoot ?? null,
        c.contextRoot ?? null,
        c.adapterSetHash,
        c.zkFactsRoot ?? null,
        c.zkContextRoot ?? null,
        c.rootVersion ?? (c.zkContextRoot ? "v3" : c.contextRoot ? "v2" : "v1"),
        JSON.stringify({
          adapterSetHash: c.adapterSetHash,
          ledgerRange: c.ledgerRange ?? null,
        }),
      ],
    );
    for (const factId of c.semanticFactIds) {
      await this.pool.query(
        `INSERT INTO capsule_facts (capsule_id, fact_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [c.id, factId],
      );
    }
    for (const srcId of c.sourceRecordIds) {
      await this.pool.query(
        `INSERT INTO capsule_sources (capsule_id, source_record_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [c.id, srcId],
      );
    }
  }

  async getSourceRecord(id: string): Promise<SourceRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM source_records WHERE id = $1",
      [id],
    );
    return rows[0] ? rowToSource(rows[0]) : null;
  }

  async getFact(id: string): Promise<SemanticFact | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM semantic_facts WHERE id = $1",
      [id],
    );
    if (!rows[0]) return null;
    return rowToFact(rows[0], await this.factSourceIds(id));
  }

  async getCapsule(id: string): Promise<ContextCapsule | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM context_capsules WHERE id = $1",
      [id],
    );
    if (!rows[0]) return null;
    const factIds = (
      await this.pool.query(
        "SELECT fact_id FROM capsule_facts WHERE capsule_id = $1",
        [id],
      )
    ).rows.map((r: any) => r.fact_id);
    const srcIds = (
      await this.pool.query(
        "SELECT source_record_id FROM capsule_sources WHERE capsule_id = $1",
        [id],
      )
    ).rows.map((r: any) => r.source_record_id);
    return rowToCapsule(rows[0], factIds, srcIds);
  }

  async queryFacts(query: FactQuery): Promise<SemanticFact[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, val: unknown) => {
      params.push(val);
      clauses.push(`${col} = $${params.length}`);
    };
    if (query.network) add("network", query.network);
    if (query.protocol) add("protocol", query.protocol);
    if (query.entityType) add("entity_type", query.entityType);
    if (query.entityId) add("entity_id", query.entityId);
    if (query.field) add("field", query.field);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = query.limit ? `LIMIT ${Number(query.limit)}` : "LIMIT 500";
    const { rows } = await this.pool.query(
      `SELECT * FROM semantic_facts ${where} ORDER BY created_at DESC ${limit}`,
      params,
    );
    const out: SemanticFact[] = [];
    for (const row of rows)
      out.push(rowToFact(row, await this.factSourceIds(row.id)));
    return out;
  }

  async getCapsuleSourceRecords(capsuleId: string): Promise<SourceRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT sr.* FROM source_records sr
       JOIN capsule_sources cs ON cs.source_record_id = sr.id
       WHERE cs.capsule_id = $1`,
      [capsuleId],
    );
    return rows.map(rowToSource);
  }

  async getCapsuleFacts(capsuleId: string): Promise<SemanticFact[]> {
    const { rows } = await this.pool.query(
      `SELECT sf.* FROM semantic_facts sf
       JOIN capsule_facts cf ON cf.fact_id = sf.id
       WHERE cf.capsule_id = $1`,
      [capsuleId],
    );
    const out: SemanticFact[] = [];
    for (const row of rows)
      out.push(rowToFact(row, await this.factSourceIds(row.id)));
    return out;
  }

  async deleteCapsulesOlderThan(beforeIso: string): Promise<number> {
    const res = await this.pool.query(
      "DELETE FROM context_capsules WHERE created_at < $1",
      [beforeIso],
    );
    return res.rowCount ?? 0;
  }

  async saveComputeIntent(i: CompiledComputeIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO compute_intents
        (id, name, intent_hash, compute_hash, context_root, source_root,
         semantic_facts_root, adapter_set_hash, ast_json, fact_refs,
         private_input_schema, reveal, hide, capsule_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO NOTHING`,
      [
        i.id, i.name, i.intentHash, i.computeHash, i.contextRoot, i.sourceRoot,
        i.semanticFactsRoot, i.adapterSetHash, JSON.stringify(i.ast),
        JSON.stringify(i.factRefs), JSON.stringify(i.privateInputSchema),
        JSON.stringify(i.reveal), JSON.stringify(i.hide), i.capsuleId, i.createdAt,
      ],
    );
  }
  async getComputeIntent(id: string): Promise<CompiledComputeIntent | null> {
    const { rows } = await this.pool.query("SELECT * FROM compute_intents WHERE id=$1", [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, name: r.name, intentHash: r.intent_hash, computeHash: r.compute_hash,
      contextRoot: r.context_root, sourceRoot: r.source_root,
      semanticFactsRoot: r.semantic_facts_root, adapterSetHash: r.adapter_set_hash,
      ast: r.ast_json, factRefs: r.fact_refs, privateInputSchema: r.private_input_schema,
      reveal: r.reveal, hide: r.hide, capsuleId: r.capsule_id,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  }
  async saveProofEnvelope(e: ProofEnvelope, computeIntentId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO proof_envelopes
        (id, proof_type, backend, compute_intent_id, public_inputs, revealed,
         proof_bytes, groth16, verification_key, verifier_contract_id,
         verification_tx, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         verifier_contract_id = EXCLUDED.verifier_contract_id,
         verification_tx = EXCLUDED.verification_tx`,
      [
        e.proofId, e.proofType, e.backend, computeIntentId ?? null,
        JSON.stringify(e.publicInputs), JSON.stringify(e.revealed), e.proofBytes,
        // Persist the full Groth16 artifacts so a reloaded envelope can still be
        // verified on-chain (durable stellar_verified).
        e.groth16 ? JSON.stringify(e.groth16) : null,
        e.verificationKey ?? null,
        e.verifierContractId ?? null, e.verificationTx ?? null, e.status, e.createdAt,
      ],
    );
  }
  async getProofEnvelope(id: string): Promise<ProofEnvelope | null> {
    const { rows } = await this.pool.query("SELECT * FROM proof_envelopes WHERE id=$1", [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      proofId: r.id, proofType: r.proof_type, backend: r.backend,
      publicInputs: r.public_inputs, revealed: r.revealed, proofBytes: r.proof_bytes,
      groth16: r.groth16 ?? undefined,
      verificationKey: r.verification_key ?? undefined,
      verifierContractId: r.verifier_contract_id ?? undefined,
      verificationTx: r.verification_tx ?? undefined, status: r.status,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    };
  }
  async getComputeIntentByProof(proofId: string): Promise<CompiledComputeIntent | null> {
    const { rows } = await this.pool.query(
      "SELECT compute_intent_id FROM proof_envelopes WHERE id=$1",
      [proofId],
    );
    const intentId = rows[0]?.compute_intent_id;
    return intentId ? this.getComputeIntent(intentId) : null;
  }

  async saveCheckpoint(c: IngestionCheckpoint): Promise<void> {
    await this.pool.query(
      `INSERT INTO ingestion_checkpoints
        (id, worker, protocol, contract_id, cursor, latest_ledger, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         latest_ledger = EXCLUDED.latest_ledger,
         updated_at = EXCLUDED.updated_at`,
      [c.id, c.worker, c.protocol, c.contractId ?? null, c.cursor ?? null, c.latestLedger ?? null, c.updatedAt],
    );
  }
  async getCheckpoint(id: string): Promise<IngestionCheckpoint | null> {
    const { rows } = await this.pool.query("SELECT * FROM ingestion_checkpoints WHERE id=$1", [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, worker: r.worker, protocol: r.protocol,
      contractId: r.contract_id ?? undefined, cursor: r.cursor ?? undefined,
      latestLedger: r.latest_ledger != null ? Number(r.latest_ledger) : undefined,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    };
  }
  async saveProofCard(c: ProofCard, proofEnvelopeId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO proof_cards
        (id, proof_envelope_id, proof_type, context_root, compute_hash,
         public_result_hash, public_result, verifier_hash, timestamp_ledger,
         result, trust_model, verification_mode, warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         verification_mode = EXCLUDED.verification_mode,
         verifier_hash = EXCLUDED.verifier_hash,
         result = EXCLUDED.result,
         warnings = EXCLUDED.warnings`,
      [
        c.proofId, proofEnvelopeId, c.proofType, c.contextRoot, c.computeHash,
        c.publicResultHash, JSON.stringify(c.publicResult), c.verifierHash ?? null,
        c.timestampLedger ?? null, c.result, c.trustModel, c.verificationMode ?? null,
        JSON.stringify(c.warnings),
      ],
    );
  }
  async getProofCard(proofId: string): Promise<ProofCard | null> {
    const { rows } = await this.pool.query("SELECT * FROM proof_cards WHERE id=$1", [proofId]);
    const r = rows[0];
    if (!r) return null;
    return {
      proofId: r.id, proofType: r.proof_type, contextRoot: r.context_root,
      computeHash: r.compute_hash, publicResultHash: r.public_result_hash,
      publicResult: r.public_result, verifierHash: r.verifier_hash ?? undefined,
      timestampLedger: r.timestamp_ledger != null ? Number(r.timestamp_ledger) : undefined,
      result: r.result, trustModel: r.trust_model,
      verificationMode: r.verification_mode ?? undefined, warnings: r.warnings ?? [],
    };
  }

  private async factSourceIds(factId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT source_record_id FROM fact_sources WHERE fact_id = $1",
      [factId],
    );
    return rows.map((r: any) => r.source_record_id);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToSource(row: any): SourceRecord {
  return {
    id: row.id,
    network: row.network,
    protocol: row.protocol,
    sourceKind: row.source_kind,
    endpoint: row.endpoint ?? undefined,
    contractId: row.contract_id ?? undefined,
    functionName: row.function_name ?? undefined,
    argsXdr: row.args_xdr ?? undefined,
    requestBodyHash: row.request_hash,
    responseHash: row.response_hash,
    rawResponseRef: row.id,
    rawResponse: row.raw_response ?? undefined,
    rawXdr: row.raw_xdr ?? undefined,
    ledgerSeq: row.ledger_seq != null ? Number(row.ledger_seq) : undefined,
    latestLedger:
      row.latest_ledger != null ? Number(row.latest_ledger) : undefined,
    fetchedAt:
      row.fetched_at instanceof Date
        ? row.fetched_at.toISOString()
        : row.fetched_at,
    adapterName: row.adapter_name,
    adapterVersion: row.adapter_version,
    adapterHash: row.adapter_hash,
  };
}

function rowToFact(row: any, sourceRecordIds: string[]): SemanticFact {
  return {
    id: row.id,
    network: row.network,
    protocol: row.protocol,
    entityType: row.entity_type,
    entityId: row.entity_id,
    field: row.field,
    value: row.value,
    unit: row.unit ?? undefined,
    ledgerSeq: row.ledger_seq != null ? Number(row.ledger_seq) : undefined,
    sourceRecordIds,
    rawHash: row.raw_hash,
    adapterHash: row.adapter_hash,
    confidence: row.confidence,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  };
}

function rowToCapsule(
  row: any,
  factIds: string[],
  srcIds: string[],
): ContextCapsule {
  const meta = row.metadata ?? {};
  return {
    id: row.id,
    capsuleType: row.capsule_type,
    network: row.network,
    protocols: row.protocols,
    sourceRecordIds: srcIds,
    semanticFactIds: factIds,
    sourceRoot: row.source_root,
    factsRoot: row.facts_root,
    semanticFactsRoot: row.semantic_facts_root ?? undefined,
    contextRoot: row.context_root ?? undefined,
    zkFactsRoot: row.zk_facts_root ?? undefined,
    zkContextRoot: row.zk_context_root ?? undefined,
    rootVersion: row.root_version ?? undefined,
    adapterSetHash: row.adapter_set_hash ?? meta.adapterSetHash ?? "0x",
    compositeRoot: row.composite_root,
    ledgerRange: meta.ledgerRange ?? undefined,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
  };
}
