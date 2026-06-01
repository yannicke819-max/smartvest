-- Migration 0185 — Architecture "TRADER chef d'orchestre"
--
-- Création de la table scanner_proposals : le scanner ne crée plus de positions
-- directement (openPositionDirect), il propose des candidats que le TRADER LLM
-- accepte ou rejette au cycle suivant.
--
-- Ajout du kind 'risk_advisory' au check constraint de lisa_decision_log :
-- le RiskMonitor passe en mode advisory (advisory_only) — il signale via
-- lisa_decision_log au lieu de modifier directement lisa_positions.stop_loss_price.
--
-- Gating runtime (env Fly) :
--   TRADER_ARBITRATION_ENABLED=true  → scanner INSERT proposals + TRADER consume
--   RISK_MONITOR_MODE=advisory       → RiskMonitor INSERT advisory au lieu UPDATE direct
-- Default = legacy direct path pour rollback safe.

CREATE TABLE IF NOT EXISTS scanner_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  asset_class TEXT,
  exchange TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('long','short')),
  notional_usd_suggested NUMERIC NOT NULL CHECK (notional_usd_suggested > 0),
  stop_loss_pct_suggested NUMERIC,
  take_profit_pct_suggested NUMERIC,
  score NUMERIC,
  change_pct NUMERIC,
  live_price_at_proposal NUMERIC,
  candidate_metrics JSONB,
  scanner_reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','expired','superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reviewed_by_trader_at TIMESTAMPTZ,
  trader_decision_reason TEXT,
  applied_position_id UUID
);

CREATE INDEX IF NOT EXISTS idx_scanner_proposals_pending
  ON scanner_proposals (portfolio_id, status, expires_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_scanner_proposals_created_at
  ON scanner_proposals (created_at DESC);

COMMENT ON TABLE scanner_proposals IS
  'Propositions de scan que le TRADER LLM consomme au cycle suivant. Le scanner ne crée plus de positions directement (architecture pilotée par TRADER, 01/06/2026).';

COMMENT ON COLUMN scanner_proposals.status IS
  'pending=non vu / accepted=TRADER a ouvert / rejected=TRADER a refusé / expired=non vu avant expires_at / superseded=remplacé par proposition plus récente même ticker';

COMMENT ON COLUMN scanner_proposals.expires_at IS
  'Au-delà, le TRADER ignore la proposition (data stale). Typique : now() + 5 min.';

COMMENT ON COLUMN scanner_proposals.applied_position_id IS
  'Si accepted, pointe vers la position lisa_positions ouverte par le TRADER (audit).';

-- Note : le check constraint sur lisa_decision_log.kind est ALTER au cas par cas.
-- L'ajout de 'risk_advisory' se fait via DO block idempotent qui inspecte le
-- constraint courant et le réécrit en ajoutant le nouveau kind sans dropper
-- les anciens. Permet de relancer la migration sans casser.

DO $$
DECLARE
  existing_check TEXT;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_check
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'lisa_decision_log'
    AND c.conname = 'lisa_decision_log_kind_check';

  IF existing_check IS NULL THEN
    RAISE NOTICE 'lisa_decision_log_kind_check introuvable, skip ajout risk_advisory';
    RETURN;
  END IF;

  IF existing_check LIKE '%risk_advisory%' THEN
    RAISE NOTICE 'kind risk_advisory déjà présent, skip';
    RETURN;
  END IF;

  ALTER TABLE lisa_decision_log DROP CONSTRAINT lisa_decision_log_kind_check;

  -- Recompose le check existant + ajoute risk_advisory.
  -- Forme attendue : CHECK ((kind = ANY (ARRAY['a','b',...])))
  EXECUTE format(
    'ALTER TABLE lisa_decision_log ADD CONSTRAINT lisa_decision_log_kind_check %s',
    regexp_replace(
      existing_check,
      '(ARRAY\[)',
      '\1''risk_advisory''::text, ''proposal_accepted''::text, ''proposal_rejected''::text, ''proposal_expired''::text, '
    )
  );

  RAISE NOTICE 'Ajouté kinds: risk_advisory, proposal_accepted, proposal_rejected, proposal_expired au check lisa_decision_log';
END $$;
