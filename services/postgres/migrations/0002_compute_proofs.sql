-- Sefi Phase 2 — ComputeKit / ProofKit schema (spec §18). Idempotent.

CREATE TABLE IF NOT EXISTS compute_intents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  compute_hash TEXT NOT NULL,
  context_root TEXT NOT NULL,
  source_root TEXT NOT NULL,
  semantic_facts_root TEXT NOT NULL,
  adapter_set_hash TEXT NOT NULL,
  ast_json JSONB NOT NULL,
  fact_refs JSONB NOT NULL,
  private_input_schema JSONB NOT NULL,
  reveal JSONB NOT NULL,
  hide JSONB NOT NULL,
  capsule_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_envelopes (
  id TEXT PRIMARY KEY,
  proof_type TEXT NOT NULL,
  backend TEXT NOT NULL,
  compute_intent_id TEXT REFERENCES compute_intents(id),
  public_inputs JSONB NOT NULL,
  revealed JSONB NOT NULL,
  proof_object_uri TEXT,
  proof_bytes TEXT,
  verifier_contract_id TEXT,
  verification_tx TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_cards (
  id TEXT PRIMARY KEY,
  proof_envelope_id TEXT REFERENCES proof_envelopes(id),
  proof_type TEXT NOT NULL,
  context_root TEXT NOT NULL,
  compute_hash TEXT NOT NULL,
  public_result_hash TEXT NOT NULL,
  public_result JSONB NOT NULL,
  verifier_hash TEXT,
  timestamp_ledger BIGINT,
  result TEXT NOT NULL,
  trust_model TEXT NOT NULL,
  verification_mode TEXT,
  warnings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proof_jobs (
  id TEXT PRIMARY KEY,
  intent_id TEXT,
  backend TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compute_intents_context_root ON compute_intents(context_root);
CREATE INDEX IF NOT EXISTS idx_proof_envelopes_status ON proof_envelopes(status);
CREATE INDEX IF NOT EXISTS idx_proof_cards_context_root ON proof_cards(context_root);
