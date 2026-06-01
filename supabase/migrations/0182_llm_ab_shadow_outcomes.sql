-- Migration 0182 — Backfill outcomes pour llm_ab_shadow_decisions
--
-- Permet de répondre à la question "qui des 4 LLMs a raison?" en liant chaque
-- shadow decision à un outcome mesurable (position fermée pour risk_monitor,
-- événements pour daily_brief, etc.).
--
-- Phase 1 (cette migration) : risk_monitor uniquement. Chaque shadow row peut
-- pointer vers une lisa_positions.id ; quand la position ferme, on backfill
-- outcome_pnl_pct + outcome_label.
--
-- Phase 2 (PR follow-up) : étendre aux 3 autres call sites avec leur propre
-- ground truth (lessons applied → J+1 outcomes, brief events → market move, etc.)

ALTER TABLE public.llm_ab_shadow_decisions
  ADD COLUMN IF NOT EXISTS target_id UUID NULL,
  ADD COLUMN IF NOT EXISTS outcome_pnl_pct NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS outcome_label TEXT NULL,
  ADD COLUMN IF NOT EXISTS outcome_resolved_at TIMESTAMPTZ NULL;

ALTER TABLE public.llm_ab_shadow_decisions
  DROP CONSTRAINT IF EXISTS llm_ab_shadow_outcome_label_chk;
ALTER TABLE public.llm_ab_shadow_decisions
  ADD CONSTRAINT llm_ab_shadow_outcome_label_chk
  CHECK (outcome_label IS NULL OR outcome_label IN ('win', 'loss', 'breakeven'));

CREATE INDEX IF NOT EXISTS idx_llm_ab_shadow_target_id
  ON public.llm_ab_shadow_decisions(target_id)
  WHERE target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_ab_shadow_unresolved
  ON public.llm_ab_shadow_decisions(call_site, created_at)
  WHERE outcome_resolved_at IS NULL AND target_id IS NOT NULL;

COMMENT ON COLUMN public.llm_ab_shadow_decisions.target_id IS
  'Lien optionnel vers l''objet évalué (e.g. lisa_positions.id pour risk_monitor). Permet le backfill outcome.';
COMMENT ON COLUMN public.llm_ab_shadow_decisions.outcome_pnl_pct IS
  'PnL final % de l''objet évalué (risk_monitor: position closed pnl).';
COMMENT ON COLUMN public.llm_ab_shadow_decisions.outcome_label IS
  'Catégorie outcome : win / loss / breakeven.';
COMMENT ON COLUMN public.llm_ab_shadow_decisions.outcome_resolved_at IS
  'Quand l''outcome a été résolu et backfillé.';
