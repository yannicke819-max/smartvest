-- 0134_gainers_user_shadow_signals
--
-- PR #280 — Phase 1 : Shadow simulator pour LE PIPELINE USER (GainersDirect),
-- distinct du shadow V1 BLOC1 (gainers_v1_shadow_signals, ADR-005).
--
-- But : mesurer en data « combien chaque gate user-pipeline coûte ou fait
-- gagner ». Permet de répondre à « si je passe path_eff de 0.45 à 0.30, est-ce
-- que je gagne ou je perds ? » avec stats bootstrap CI 95%.
--
-- Architecture :
--   1. À chaque gate dans TopGainersScannerService.scanPortfolio, on capte la
--      décision (accept / reject_<reason>) + snapshot config active.
--   2. Worker simulatePending (in-line au début de chaque cycle scanner)
--      walk-forward sur candles 5m du candidat sur 30 + 60 min, applique
--      TP 2%/SL 0.9% (baseline) + grille secondaire TP 1.5%/SL 0.6%, slippage
--      haircut 0.15% bilatéral (= -30bps net).
--   3. Endpoint /lisa/gainers-shadow-regret aggrège par gate + bootstrap CI
--      95% sur sim_pnl_pct → verdict GATE_HEALTHY / GATE_TOO_STRICT / INCONCLUSIVE.
--
-- Rétention 30 jours (cron purge à wirer plus tard, table pas critique).

CREATE TABLE IF NOT EXISTS public.gainers_user_shadow_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- Candidate snapshot
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  change_pct_1m NUMERIC(8,4),
  score NUMERIC(5,4),
  path_eff NUMERIC(5,4),
  persistence_score NUMERIC(5,4),
  persistence_count TEXT,    -- "5/6" format
  entry_price NUMERIC(28,10),
  notional_usd NUMERIC(18,4),

  -- Decision @ this gate
  decision TEXT NOT NULL CHECK (decision IN (
    'accept',
    'reject_path_eff',
    'reject_persistence',
    'reject_cooldown',
    'reject_post_sl_cooldown',
    'reject_p_win',
    'reject_budget_cap',
    'reject_no_tf_data',
    'reject_other'
  )),

  -- Config snapshot (pour audit + recalibration future)
  cfg_min_path_eff NUMERIC(5,4),
  cfg_min_persistence NUMERIC(5,4),
  cfg_asia_boost NUMERIC(5,4),
  cfg_tp_pct NUMERIC(5,3),
  cfg_sl_pct NUMERIC(5,3),
  is_asia BOOLEAN NOT NULL DEFAULT false,

  -- Simulated outcomes (rempli post-hoc par simulatePending)
  -- 4 grilles : (baseline TP 2%/SL 0.9% × 30min/60min) + (secondaire TP 1.5%/SL 0.6% × 30min/60min)
  -- JSONB pour extensibilité future (autres grilles sans migration)
  --   Schema : {
  --     "baseline_30m": { outcome, exit_price, exit_at, pnl_pct, hit_at_min },
  --     "baseline_60m": { ... },
  --     "alt15_30m":   { ... },
  --     "alt15_60m":   { ... }
  --   }
  --   outcome ∈ 'TP_HIT' | 'SL_HIT' | 'TIME_LIMIT' | 'NO_DATA'
  --   pnl_pct = NET (slippage 30bps round-trip déjà soustrait)
  sim_results JSONB,
  sim_run_at TIMESTAMPTZ,
  sim_window_max_min INT NOT NULL DEFAULT 60
);

-- Index pour worker simulatePending (pick rows en attente)
CREATE INDEX IF NOT EXISTS gainers_user_shadow_pending_sim_idx
  ON public.gainers_user_shadow_signals(created_at DESC)
  WHERE sim_run_at IS NULL;

-- Index pour aggregation /regret
CREATE INDEX IF NOT EXISTS gainers_user_shadow_decision_portfolio_idx
  ON public.gainers_user_shadow_signals(portfolio_id, decision, created_at DESC);

-- Index pour purge rétention
CREATE INDEX IF NOT EXISTS gainers_user_shadow_created_idx
  ON public.gainers_user_shadow_signals(created_at);

ALTER TABLE public.gainers_user_shadow_signals ENABLE ROW LEVEL SECURITY;

-- RLS : user voit ses portfolios uniquement (via lien portfolios.user_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gainers_user_shadow_signals'
      AND policyname = 'gainers_user_shadow_owner_select'
  ) THEN
    CREATE POLICY gainers_user_shadow_owner_select ON public.gainers_user_shadow_signals
      FOR SELECT USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.gainers_user_shadow_signals IS
  'PR #280 — Shadow user-pipeline signals + simulated TP/SL outcomes. '
  'Permet de mesurer le regret cost de chaque gate (path_eff, persistence...) '
  'avec bootstrap CI 95% sur PnL/trade. Rétention 30j.';
