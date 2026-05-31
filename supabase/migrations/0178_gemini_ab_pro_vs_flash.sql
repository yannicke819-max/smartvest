-- Migration 0178 — A/B shadow Pro vs Flash sur LiveTraderAgent
--
-- Contexte : suite à PR1-3 cost-cuts, on souhaite mesurer empiriquement la
-- différence de qualité Gemini 2.5 Pro vs Gemini 2.5 Flash sur les décisions
-- TRADER. Pour chaque cycle TRADER, on appelle Gemini Pro (décision réelle
-- appliquée) ET Gemini Flash (décision shadow, jamais appliquée). On logge
-- les deux pour comparaison + outcomes.
--
-- Objectif analyse :
--   - Concordance % : combien de cycles Pro et Flash sortent la même décision
--   - Divergences : quand ils divergent, qui a raison (outcome PnL)
--   - Coût : ratio coût Pro / coût Flash sur 7 jours
--   - Décision data-driven : si Flash ≥ 90% qualité Pro, migrer TRADER vers Flash
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS public.gemini_ab_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at timestamptz NOT NULL DEFAULT NOW(),
  portfolio_id uuid NOT NULL,
  cycle_started_at timestamptz NOT NULL,

  -- Décision Pro (celle qui a été APPLIQUÉE par TRADER)
  pro_action_kind text,
  pro_target_symbol text,
  pro_direction text,
  pro_confidence numeric(3, 2),
  pro_notional_usd numeric(12, 2),
  pro_thesis text,
  pro_cost_usd numeric(10, 6),
  pro_latency_ms int,
  pro_provider text,
  pro_applied boolean,
  pro_apply_error text,

  -- Décision Flash (shadow uniquement, jamais appliquée)
  flash_action_kind text,
  flash_target_symbol text,
  flash_direction text,
  flash_confidence numeric(3, 2),
  flash_notional_usd numeric(12, 2),
  flash_thesis text,
  flash_cost_usd numeric(10, 6),
  flash_latency_ms int,
  flash_provider text,
  flash_call_error text, -- si l'appel Flash a échoué (timeout, parse fail)

  -- Comparaison Pro vs Flash (calculée à l'insert)
  concordance_action_kind boolean, -- true si pro_action_kind === flash_action_kind
  concordance_target_symbol boolean, -- true si pro_target_symbol === flash_target_symbol
  concordance_full boolean, -- true si action_kind AND target_symbol identiques
  confidence_delta numeric(4, 3), -- pro_confidence - flash_confidence (signed)

  -- Outcome backfill (si la décision a abouti à une position fermée)
  -- Backfill manuel ou via cron à coder ultérieurement. NULL initialement.
  outcome_position_id uuid REFERENCES public.lisa_positions(id) ON DELETE SET NULL,
  outcome_pnl_usd numeric(10, 2),
  outcome_win boolean,
  outcome_resolved_at timestamptz,

  -- Contexte (snapshot minimal pour debug)
  candidates_count int, -- nombre de candidats au feed au moment du cycle
  context_hash text -- hash sha256 du contexte input (pour détecter si Pro et Flash ont vu le même contexte)
);

CREATE INDEX IF NOT EXISTS gemini_ab_decisions_decided_at_idx
  ON public.gemini_ab_decisions (decided_at DESC);

CREATE INDEX IF NOT EXISTS gemini_ab_decisions_portfolio_idx
  ON public.gemini_ab_decisions (portfolio_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS gemini_ab_decisions_concordance_idx
  ON public.gemini_ab_decisions (concordance_full, decided_at DESC);

CREATE INDEX IF NOT EXISTS gemini_ab_decisions_outcome_idx
  ON public.gemini_ab_decisions (outcome_position_id) WHERE outcome_position_id IS NOT NULL;

COMMENT ON TABLE public.gemini_ab_decisions IS
'A/B shadow Pro vs Flash sur LiveTraderAgent. Pour chaque cycle TRADER, appel parallèle Pro (appliqué) + Flash (shadow). Aggrégations possibles : concordance %, divergence outcomes, ratio coût. Cf. migration 0178 + PR4.';

COMMENT ON COLUMN public.gemini_ab_decisions.concordance_full IS
'true si pro_action_kind === flash_action_kind ET pro_target_symbol === flash_target_symbol. Métrique principale pour décision Pro→Flash.';

COMMENT ON COLUMN public.gemini_ab_decisions.confidence_delta IS
'pro_confidence - flash_confidence. Signed : positif = Pro plus confiant, négatif = Flash plus confiant.';

COMMENT ON COLUMN public.gemini_ab_decisions.outcome_position_id IS
'Référence position ouverte suite à la décision (Pro applied). Backfill via cron resolveCitationOutcomes-like quand position close.';

-- RLS — table accessible uniquement via service role.
ALTER TABLE public.gemini_ab_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gemini_ab_decisions_service_only" ON public.gemini_ab_decisions;
CREATE POLICY "gemini_ab_decisions_service_only" ON public.gemini_ab_decisions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
