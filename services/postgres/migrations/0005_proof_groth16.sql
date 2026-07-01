-- Persist Groth16 artifacts so durable (reloaded) proof envelopes can still be
-- verified on-chain (stellar_verified). Idempotent.

ALTER TABLE proof_envelopes ADD COLUMN IF NOT EXISTS groth16 JSONB;
ALTER TABLE proof_envelopes ADD COLUMN IF NOT EXISTS verification_key TEXT;
