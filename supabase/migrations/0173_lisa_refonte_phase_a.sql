-- 0173 — LISA refonte Phase A
--
-- Foundation pour la nouvelle UI /lisa centrée TRADER :
--   1. Capital composé : initial_capital + compound_pnl_enabled
--   2. Objectifs dynamiques Mode C (MAX(fixe $, % capital)) jour/mois/an
--   3. Daily digest email préférences
--   4. Strategy Coach enable flag
--   5. Tables coach_proposals (queue) + scanner_lesson_citations (tracking)
--
-- Migration idempotente — toutes les colonnes/tables ajoutées avec IF NOT EXISTS.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Extension lisa_session_configs pour TRADER (portfolio b0000001-...)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lisa_session_configs
  -- Capital composé
  ADD COLUMN IF NOT EXISTS lisa_initial_capital_usd numeric(12, 2) DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS lisa_compound_pnl_enabled boolean DEFAULT true,

  -- Objectifs dynamiques Mode C : plancher en $ ET % du capital
  -- Cible effective = MAX(target_*_usd, target_*_pct × current_capital)
  ADD COLUMN IF NOT EXISTS lisa_target_daily_usd numeric(10, 2) DEFAULT 200,
  ADD COLUMN IF NOT EXISTS lisa_target_daily_pct numeric(5, 2) DEFAULT 2.00,
  ADD COLUMN IF NOT EXISTS lisa_target_monthly_usd numeric(10, 2) DEFAULT 4000,
  ADD COLUMN IF NOT EXISTS lisa_target_monthly_pct numeric(5, 2) DEFAULT 20.00,
  ADD COLUMN IF NOT EXISTS lisa_target_annual_usd numeric(12, 2) DEFAULT 50000,
  ADD COLUMN IF NOT EXISTS lisa_target_annual_pct numeric(5, 2) DEFAULT 100.00,

  -- Notifications
  ADD COLUMN IF NOT EXISTS lisa_daily_digest_enabled boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS lisa_notification_email text DEFAULT NULL,

  -- Strategy Coach
  ADD COLUMN IF NOT EXISTS lisa_strategy_coach_enabled boolean DEFAULT true;

COMMENT ON COLUMN public.lisa_session_configs.lisa_initial_capital_usd IS
'Capital de base TRADER. Capital actuel = initial + Σ realized_pnl si compound_pnl_enabled.';

COMMENT ON COLUMN public.lisa_session_configs.lisa_compound_pnl_enabled IS
'Si true, le sizing Kelly utilise (initial + Σ pnl). Si false, sizing utilise initial fixe (legacy).';

COMMENT ON COLUMN public.lisa_session_configs.lisa_target_daily_usd IS
'Plancher cible jour en USD. Cible effective = MAX(usd, pct × current_capital).';

COMMENT ON COLUMN public.lisa_session_configs.lisa_target_daily_pct IS
'Cible jour en % du capital actuel. Couplé avec lisa_target_daily_usd pour Mode C hybride.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. coach_proposals — queue des propositions Strategy Coach AVANT validation user
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.coach_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  portfolio_id uuid NOT NULL,

  -- Source du run
  source text NOT NULL DEFAULT 'cron_hourly', -- cron_hourly | cron_daily | on_demand | target_change
  triggered_by text DEFAULT NULL, -- user_id si on_demand
  llm_model text NOT NULL DEFAULT 'gemini-flash', -- gemini-flash | gemini-pro
  llm_cost_usd numeric(8, 4) DEFAULT 0,
  llm_latency_ms integer DEFAULT 0,

  -- Contexte input (snapshot)
  input_context jsonb NOT NULL,
  -- { current_capital, targets, stats_30d, top_lessons, retrospectives, ... }

  -- Output Gemini structuré
  feasibility_verdict text,
  -- 'REACHABLE' | 'NEEDS_CHANGES' | 'UNREALISTIC'
  feasibility_probability_pct numeric(5, 2),
  feasibility_rationale text,

  -- Propositions concrètes
  proposed_lessons jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ lesson_kind, lesson_text, confidence, scope, expected_impact_usd, rationale, ... }]
  proposed_parameter_changes jsonb DEFAULT '[]'::jsonb,
  -- [{ param, current, proposed, rationale, expected_impact }]
  risk_warnings jsonb DEFAULT '[]'::jsonb,
  -- [text, text, ...]

  -- Statut user review
  status text NOT NULL DEFAULT 'pending',
  -- 'pending' | 'partially_accepted' | 'fully_accepted' | 'rejected' | 'expired'
  reviewed_at timestamptz DEFAULT NULL,
  reviewed_by text DEFAULT NULL,
  user_decision jsonb DEFAULT NULL,
  -- { accepted_lessons: [...], rejected_lessons: [...], applied_params: [...], comment }

  -- Lessons effectivement créées (FK vers scanner_lessons)
  resulted_lesson_ids uuid[] DEFAULT '{}',

  -- Anti-bruit / anti-redondance
  pattern_hash text, -- hash similarity contre propositions précédentes
  notified_at timestamptz DEFAULT NULL -- timestamp envoi notification user
);

CREATE INDEX IF NOT EXISTS coach_proposals_portfolio_created_idx
  ON public.coach_proposals (portfolio_id, created_at DESC);

CREATE INDEX IF NOT EXISTS coach_proposals_status_idx
  ON public.coach_proposals (status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS coach_proposals_pattern_hash_idx
  ON public.coach_proposals (pattern_hash) WHERE pattern_hash IS NOT NULL;

COMMENT ON TABLE public.coach_proposals IS
'Queue des propositions Strategy Coach (Gemini Flash hourly + Pro escalation). User valide avant insert dans scanner_lessons.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. scanner_lesson_citations — tracking impact lessons cited par TRADER
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.scanner_lesson_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cited_at timestamptz NOT NULL DEFAULT now(),

  -- Lesson référencée (peut être null si marker non mappé)
  lesson_id uuid REFERENCES public.scanner_lessons(id) ON DELETE SET NULL,
  marker_text text NOT NULL,
  -- ex: "[PULLBACK_WAIT_KTOS_LESSON]" | "[KELLY_BOOST_A++]" | "pumpScore" | etc.

  -- Source de la citation
  portfolio_id uuid NOT NULL,
  decision_decided_at timestamptz NOT NULL,
  action_kind text NOT NULL,
  -- 'hold' | 'open_directional' | 'close' | 'trail_stop' | 'scale_in'
  action_applied boolean NOT NULL DEFAULT false,
  target_symbol text DEFAULT NULL,
  confidence numeric(3, 2) DEFAULT NULL,

  -- Outcome si action_applied → trade
  position_id uuid REFERENCES public.lisa_positions(id) ON DELETE SET NULL,
  outcome_resolved_at timestamptz DEFAULT NULL,
  outcome_pnl_usd numeric(10, 2) DEFAULT NULL,
  outcome_win boolean DEFAULT NULL,

  -- Contexte
  thesis_excerpt text, -- 300 chars max
  context_snapshot jsonb DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS scanner_lesson_citations_lesson_idx
  ON public.scanner_lesson_citations (lesson_id, cited_at DESC) WHERE lesson_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS scanner_lesson_citations_portfolio_idx
  ON public.scanner_lesson_citations (portfolio_id, cited_at DESC);

CREATE INDEX IF NOT EXISTS scanner_lesson_citations_marker_idx
  ON public.scanner_lesson_citations (marker_text, cited_at DESC);

COMMENT ON TABLE public.scanner_lesson_citations IS
'Track citations des lessons par TRADER. Outcome lié si position fermée. Métriques agrégées pour Lessons Impact Tracker UI.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS policies (read-only pour user, write seulement via service role)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.coach_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scanner_lesson_citations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coach_proposals_select_owner" ON public.coach_proposals;
CREATE POLICY "coach_proposals_select_owner" ON public.coach_proposals
  FOR SELECT USING (
    portfolio_id IN (
      SELECT id FROM public.portfolios WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "scanner_lesson_citations_select_owner" ON public.scanner_lesson_citations;
CREATE POLICY "scanner_lesson_citations_select_owner" ON public.scanner_lesson_citations
  FOR SELECT USING (
    portfolio_id IN (
      SELECT id FROM public.portfolios WHERE user_id = auth.uid()
    )
  );
