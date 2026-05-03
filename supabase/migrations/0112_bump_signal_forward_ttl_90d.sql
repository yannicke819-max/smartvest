-- Migration 0112 — PR6.8.1 patch : bump RCFT TTL 30j → 90j.
--
-- Justification : AutoTuner V2 #224 voudra des FP-rate longitudinaux pour gates
-- à faible cadence (rare reject_reason). 30j trop court — bump à 90j donne marge
-- pour analyses trimestrielles.
--
-- Impact stockage : 1000 rows/day × 90j = ~90k rows steady state (vs 30k avant).
-- Acceptable pour Postgres.
--
-- Idempotente : ALTER ... SET DEFAULT est idempotent. UPDATE WHERE backfill rows
-- existantes (créées avec ancien default 30j) vers 90j.

-- Step 1 : modifie le default pour les futures inserts
ALTER TABLE gainers_signal_forward
  ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '90 days');

-- Step 2 : backfill rows existantes encore actives (créées avec default 30j)
-- Migration idempotente : ne touche que rows où le calcul donnerait > expires_at actuel.
UPDATE gainers_signal_forward
SET expires_at = created_at + INTERVAL '90 days'
WHERE expires_at < created_at + INTERVAL '90 days';

COMMENT ON COLUMN gainers_signal_forward.expires_at IS 'TTL 90j (PR6.8.1 bump). Cleanup via cron daily 00:30 UTC DELETE WHERE expires_at < NOW().';
