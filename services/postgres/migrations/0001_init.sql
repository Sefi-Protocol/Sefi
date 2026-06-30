-- Sefi Stellar — canonical schema (spec §7).
-- Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS protocols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  network TEXT NOT NULL,
  type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocol_entities (
  id TEXT PRIMARY KEY,
  protocol_id TEXT REFERENCES protocols(id),
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  display_name TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_records (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  protocol TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  endpoint TEXT,
  contract_id TEXT,
  function_name TEXT,
  args_xdr TEXT,
  request_hash TEXT NOT NULL,
  response_hash TEXT NOT NULL,
  raw_response JSONB,
  raw_xdr TEXT,
  ledger_seq BIGINT,
  latest_ledger BIGINT,
  fetched_at TIMESTAMPTZ NOT NULL,
  adapter_name TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  adapter_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_facts (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  protocol TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value JSONB NOT NULL,
  unit TEXT,
  ledger_seq BIGINT,
  raw_hash TEXT NOT NULL,
  adapter_hash TEXT NOT NULL,
  confidence TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fact_sources (
  fact_id TEXT REFERENCES semantic_facts(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE CASCADE,
  PRIMARY KEY (fact_id, source_record_id)
);

CREATE TABLE IF NOT EXISTS context_capsules (
  id TEXT PRIMARY KEY,
  capsule_type TEXT NOT NULL,
  network TEXT NOT NULL,
  protocols TEXT[] NOT NULL,
  source_root TEXT NOT NULL,
  facts_root TEXT NOT NULL,
  composite_root TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capsule_facts (
  capsule_id TEXT REFERENCES context_capsules(id) ON DELETE CASCADE,
  fact_id TEXT REFERENCES semantic_facts(id) ON DELETE CASCADE,
  PRIMARY KEY (capsule_id, fact_id)
);

CREATE TABLE IF NOT EXISTS capsule_sources (
  capsule_id TEXT REFERENCES context_capsules(id) ON DELETE CASCADE,
  source_record_id TEXT REFERENCES source_records(id) ON DELETE CASCADE,
  PRIMARY KEY (capsule_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_facts_protocol_entity
  ON semantic_facts(protocol, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_field ON semantic_facts(field);
CREATE INDEX IF NOT EXISTS idx_facts_created_at ON semantic_facts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_protocol_kind
  ON source_records(protocol, source_kind);
CREATE INDEX IF NOT EXISTS idx_sources_ledger ON source_records(ledger_seq DESC);
