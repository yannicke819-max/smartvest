-- 0135_gainers_adaptive_proposals_and_mode
--
-- PR #282 — Phase 3, étape 2 : Adaptive Selectivity lit cumulative_regret_usd
-- (PR #280) sur fenêtre 7j glissants et propose / auto-relax les gates trop
-- stricts. Distinct du trajectory_status existant (basé sur réalisé 7j) qui
-- agit sur persistence/path_eff via une logique différente.
--
-- Spec utilisateur (Lopez de Prado / Bailey) :
--   - ROLLING 7j cumulé > $150 ET n_rejections_7d ≥ 30 (volume + magnitude)
--   - NON auto-tightening (asymétrie saine — relax auto, tighten manuel)
--   - HYBRIDE : mode='propose' default, flip 'auto' conditionné AUC ≥ 0.55
--     + 5 proposals appliquées avec PnL+ post-application sur 7j
--   - Floor protection : path_eff ≥ 0.20, persistence ≥ 0.40, cooldown ≥ 1
--   - Cooldown 7j par gate après une application
--
-- Tables :
--   1. lisa_session_configs.adaptive_mode (column) — off|propose|auto
--   2. gainers_adaptive_proposals — append-only audit + actionable rows UI
--
-- Pas de table "daily snapshot" : la décision est sur rolling 7j cumulé,
-- recalculé from gainers_user_shadow_signals à chaque check (cron 5min).
-- Pas besoin de pré-aggréger.

-- ───────────────────────────────────────────────────────────────────
-- 1. Mode adaptatif par-portfolio
-- ───────────────────────────────────────────────────────────────────

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS adaptive_mode TEXT NOT NULL DEFAULT 'off'
    CHECK (adaptive_mode IN ('off', 'propose', 'auto'));

COMMENT ON COLUMN public.lisa_session_configs.adaptive_mode IS
  'PR #282 — Mode auto-relax sur les gates user-pipeline. '
  '"off" (default) : aucun calcul. '
  '"propose" : INSERT row dans gainers_adaptive_proposals, UI affiche, user clique. '
  '"auto" : applique direct sur lisa_session_configs (avec audit). '
  'Flip "propose"→"auto" recommandé seulement si AUC ≥ 0.55 ET 5 proposals validées avec PnL+ post-7j.';

-- ───────────────────────────────────────────────────────────────────
-- 2. Audit append-only des proposals (et applications)
-- ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.gainers_adaptive_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- Cible : quel gate, quelle colonne
  gate TEXT NOT NULL CHECK (gate IN (
    'reject_path_eff',
    'reject_persistence',
    'reject_cooldown',
    'reject_post_sl_cooldown'
  )),
  config_column TEXT NOT NULL,            -- ex 'gainers_min_path_efficiency'
  old_value NUMERIC(10,4) NOT NULL,
  new_value NUMERIC(10,4) NOT NULL,
  step_kind TEXT NOT NULL CHECK (step_kind IN ('subtract_0_05', 'divide_2', 'manual')),

  -- Justification stat
  cumulative_regret_usd NUMERIC(12,2) NOT NULL,    -- positif = on rate de l'argent
  n_rejections_7d INT NOT NULL,
  mean_pnl_pct NUMERIC(8,5),                       -- moyenne sim PnL/trade
  ci_low NUMERIC(8,5),                             -- bootstrap CI 95%
  ci_high NUMERIC(8,5),
  verdict TEXT NOT NULL,                            -- 'GATE_TOO_STRICT' attendu

  -- État de la proposal
  mode TEXT NOT NULL CHECK (mode IN ('propose', 'auto')),
  applied BOOLEAN NOT NULL DEFAULT false,
  applied_at TIMESTAMPTZ,
  applied_by TEXT,                                  -- 'auto_cron' | user email

  -- Outcome post-application (rempli J+7 par cron pour calibration mode auto)
  outcome_check_at TIMESTAMPTZ,                     -- timestamp du check J+7
  outcome_pnl_7d_post_usd NUMERIC(12,2),            -- realized PnL portfolio 7j post-application
  outcome_label TEXT CHECK (outcome_label IS NULL OR outcome_label IN ('positive', 'negative', 'neutral'))
);

-- Cooldown lookup : "dernière application sur ce portfolio×gate"
CREATE INDEX IF NOT EXISTS gainers_adaptive_proposals_portfolio_gate_idx
  ON public.gainers_adaptive_proposals(portfolio_id, gate, applied_at DESC)
  WHERE applied = true;

-- UI list des proposals pending (mode='propose', applied=false)
CREATE INDEX IF NOT EXISTS gainers_adaptive_proposals_pending_idx
  ON public.gainers_adaptive_proposals(portfolio_id, created_at DESC)
  WHERE applied = false;

-- Outcome backfill (cron J+7 doit picker les rows applied sans outcome)
CREATE INDEX IF NOT EXISTS gainers_adaptive_proposals_outcome_pending_idx
  ON public.gainers_adaptive_proposals(applied_at)
  WHERE applied = true AND outcome_check_at IS NULL;

ALTER TABLE public.gainers_adaptive_proposals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gainers_adaptive_proposals'
      AND policyname = 'gainers_adaptive_proposals_owner_select'
  ) THEN
    CREATE POLICY gainers_adaptive_proposals_owner_select ON public.gainers_adaptive_proposals
      FOR SELECT USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.gainers_adaptive_proposals IS
  'PR #282 — Audit append-only des proposals auto-relax (et applications). '
  'Permet à l''UI de lister les pending + au cron J+7 de mesurer outcome_pnl_7d_post '
  'pour calibrer la confiance dans le mode "auto".';
