-- Migration 0166 — Shadow Sizing Portfolios + AI Auto-Tuner infra
-- ----------------------------------------------------------------------
-- Crée 3 portfolios shadow (high / middle / small) pour benchmarker sizing
-- sur la même watchlist en parallèle du portfolio principal. Tous bypassent
-- persistence (=0) et path_eff (=0), passent dans le reste du pipeline.
--
-- Target $200/jour (objectif user). Cron 30min écrit snapshot + AI auto-
-- correction (kill-switch drawdown, sizing tune suggestions) via les 2
-- nouvelles tables.
-- ----------------------------------------------------------------------

-- 1. Insertion des 3 portfolios shadow (idempotent via ON CONFLICT)
INSERT INTO public.lisa_session_configs (
  user_id, portfolio_id, profile, capital_usd, strategy_mode, autopilot_enabled, kill_switch_active,
  gainers_max_open_positions, gainers_position_pct, gainers_max_per_cycle, gainers_cash_reserve_pct,
  gainers_min_persistence_score, gainers_min_path_efficiency,
  gainers_default_tp_pct, gainers_default_sl_pct,
  gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto,
  daily_cost_budget_usd, autopilot_cycle_minutes, gainers_cycle_minutes,
  base_currency
)
VALUES
  -- HIGH: 3 positions × $3500 (concentré, gros sizing)
  ('5f164201-9736-4867-8756-a1653d65fd1c',
   'a0000001-0000-0000-0000-000000000001',
   'active_trading', 10500, 'gainers', true, false,
   3, 33.33, 1, 0,
   0, 0,
   1.5, 1.0,
   true, true, true, true,
   50, 5, 5,
   'USD'),
  -- MIDDLE: 15 positions × $700 (équilibré)
  ('5f164201-9736-4867-8756-a1653d65fd1c',
   'a0000002-0000-0000-0000-000000000002',
   'active_trading', 10500, 'gainers', true, false,
   15, 6.67, 4, 0,
   0, 0,
   1.5, 1.0,
   true, true, true, true,
   50, 5, 5,
   'USD'),
  -- SMALL: 40 positions × $262 (diversifié, micro-sizing)
  ('5f164201-9736-4867-8756-a1653d65fd1c',
   'a0000003-0000-0000-0000-000000000003',
   'active_trading', 10500, 'gainers', true, false,
   40, 2.5, 8, 0,
   0, 0,
   1.5, 1.0,
   true, true, true, true,
   50, 5, 5,
   'USD')
ON CONFLICT (portfolio_id) DO UPDATE SET
  gainers_max_open_positions = EXCLUDED.gainers_max_open_positions,
  gainers_position_pct = EXCLUDED.gainers_position_pct,
  gainers_max_per_cycle = EXCLUDED.gainers_max_per_cycle,
  gainers_cash_reserve_pct = EXCLUDED.gainers_cash_reserve_pct,
  gainers_min_persistence_score = EXCLUDED.gainers_min_persistence_score,
  gainers_min_path_efficiency = EXCLUDED.gainers_min_path_efficiency,
  capital_usd = EXCLUDED.capital_usd,
  strategy_mode = EXCLUDED.strategy_mode,
  autopilot_enabled = EXCLUDED.autopilot_enabled,
  kill_switch_active = EXCLUDED.kill_switch_active,
  gainers_universe_us = EXCLUDED.gainers_universe_us,
  gainers_universe_eu = EXCLUDED.gainers_universe_eu,
  gainers_universe_asia = EXCLUDED.gainers_universe_asia,
  gainers_universe_crypto = EXCLUDED.gainers_universe_crypto,
  updated_at = NOW();

-- 2. Snapshot table — cron 30min écrit ici (PnL + fees + benchmark vs $200/j)
CREATE TABLE IF NOT EXISTS public.shadow_sizing_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL,
  profile_name TEXT NOT NULL CHECK (profile_name IN ('high', 'middle', 'small')),
  open_positions INT NOT NULL DEFAULT 0,
  closed_today INT NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  unrealized_pnl_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_pnl_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  win_rate_pct NUMERIC(5, 2),
  fees_paid_usd NUMERIC(10, 2) NOT NULL DEFAULT 0,
  net_pnl_after_fees_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  daily_pnl_extrapolated_usd NUMERIC(12, 2),
  target_progress_pct NUMERIC(6, 2),
  drawdown_today_pct NUMERIC(6, 2),
  capacity_used_pct NUMERIC(5, 2),
  CONSTRAINT fk_portfolio FOREIGN KEY (portfolio_id) REFERENCES public.lisa_session_configs(portfolio_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shadow_sizing_snapshot_captured_at
  ON public.shadow_sizing_snapshot(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_sizing_snapshot_portfolio
  ON public.shadow_sizing_snapshot(portfolio_id, captured_at DESC);

-- 3. Auto-tune decisions log — l'IA d'auto-correction écrit ici chaque action
CREATE TABLE IF NOT EXISTS public.shadow_sizing_autotune_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL,
  profile_name TEXT,
  decision_kind TEXT NOT NULL CHECK (decision_kind IN (
    'kill_switch_drawdown',
    'sizing_suggestion',
    'restart_after_pause',
    'fees_alert',
    'target_progress',
    'no_action'
  )),
  trigger_metric TEXT,
  trigger_value NUMERIC,
  threshold_value NUMERIC,
  action_applied BOOLEAN NOT NULL DEFAULT false,
  rationale TEXT,
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_shadow_sizing_autotune_decided_at
  ON public.shadow_sizing_autotune_log(decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_sizing_autotune_portfolio
  ON public.shadow_sizing_autotune_log(portfolio_id, decided_at DESC);

COMMENT ON TABLE public.shadow_sizing_snapshot IS
  'Snapshot cron 30min des 3 profiles shadow sizing (high/middle/small). Target $200/jour.';
COMMENT ON TABLE public.shadow_sizing_autotune_log IS
  'AI auto-correction log : kill-switch drawdown, sizing suggestions, fees alerts, target progress.';
