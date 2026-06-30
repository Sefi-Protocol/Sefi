-- Sefi Phase 2 audit fix — persist v2/v3 capsule roots (audit Part B). Idempotent.

ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS semantic_facts_root TEXT;
ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS context_root TEXT;
-- adapter_set_hash was previously only inside metadata JSON; promote to a column.
ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS adapter_set_hash TEXT;
ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS zk_facts_root TEXT;
ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS zk_context_root TEXT;
ALTER TABLE context_capsules ADD COLUMN IF NOT EXISTS root_version TEXT NOT NULL DEFAULT 'v2';

CREATE INDEX IF NOT EXISTS idx_capsules_context_root ON context_capsules(context_root);
CREATE INDEX IF NOT EXISTS idx_capsules_zk_context_root ON context_capsules(zk_context_root);
