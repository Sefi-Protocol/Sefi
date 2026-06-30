-- Sefi Phase 1 reliability — persist worker ingestion checkpoints (audit Part J).
CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  id TEXT PRIMARY KEY,            -- worker:protocol:contract
  worker TEXT NOT NULL,
  protocol TEXT NOT NULL,
  contract_id TEXT,
  cursor TEXT,
  latest_ledger BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
