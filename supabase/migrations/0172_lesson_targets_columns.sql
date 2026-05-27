-- 0172 — Add columns ciblées par scanner_lessons (auto-apply enablement).
--
-- Contexte 27/05/2026 — Le pipeline LessonAutoApplyService générait des UPDATE
-- silently failing parce que les colonnes cibles n'existaient pas dans
-- lisa_session_configs. Cette migration ajoute toutes les colonnes attendues
-- par les lessons actuellement persistées (audit via proposed_config_change).
--
-- Sources des défauts :
--   - shape_pattern lessons (agent Phase 1.5 winners curves)
--   - trade_metrics lessons (agent Phase 1 MFE/MAE)
--   - losing_pattern lessons (post-mortem nightly)
--
-- IMPORTANT : ajouter la colonne ne fait PAS que le code la consomme. Chaque
-- lesson target nécessite un code path consumer dans top-gainers-scanner.service
-- ou live-trader-agent.service. Cette migration permet juste à l'UPDATE de
-- réussir + à l'observability ("applied=true signifie vraiment applied").
--
-- Plan progressif d'implémentation des consumers : ticket follow-up séparé.

-- === Shape pattern config ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_choppy_exit_after_min INT DEFAULT 10
    CHECK (gainers_choppy_exit_after_min >= 0 AND gainers_choppy_exit_after_min <= 120);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_choppy_min_monotonicity NUMERIC(4,3) DEFAULT 0.55
    CHECK (gainers_choppy_min_monotonicity >= 0 AND gainers_choppy_min_monotonicity <= 1);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_let_run_if_monotonic_threshold NUMERIC(4,3) DEFAULT 0.85
    CHECK (gainers_let_run_if_monotonic_threshold >= 0 AND gainers_let_run_if_monotonic_threshold <= 1);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_let_run_max_drawdown_pct NUMERIC(5,3) DEFAULT 0.3
    CHECK (gainers_let_run_max_drawdown_pct >= 0 AND gainers_let_run_max_drawdown_pct <= 10);

-- === Early-exit-guard config (FADE Gemini calibration) ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_early_exit_drawdown_threshold_pct NUMERIC(5,3) DEFAULT 1.5
    CHECK (gainers_early_exit_drawdown_threshold_pct >= 0 AND gainers_early_exit_drawdown_threshold_pct <= 10);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_early_exit_min_age_seconds INT DEFAULT 60
    CHECK (gainers_early_exit_min_age_seconds >= 0 AND gainers_early_exit_min_age_seconds <= 3600);

-- === Micro-momentum config ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_micro_momentum_min_age_minutes INT DEFAULT 5
    CHECK (gainers_micro_momentum_min_age_minutes >= 0 AND gainers_micro_momentum_min_age_minutes <= 60);

-- === Trailing stop config (per-class) ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_trailing_min_age_minutes_asia INT DEFAULT 5
    CHECK (gainers_trailing_min_age_minutes_asia >= 0 AND gainers_trailing_min_age_minutes_asia <= 120);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_trailing_stop_breakeven_min_drawdown_pct NUMERIC(5,3) DEFAULT 0.5
    CHECK (gainers_trailing_stop_breakeven_min_drawdown_pct >= 0 AND gainers_trailing_stop_breakeven_min_drawdown_pct <= 5);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_trailing_tp_multiplier_monotonic NUMERIC(4,2) DEFAULT 1.5
    CHECK (gainers_trailing_tp_multiplier_monotonic >= 1 AND gainers_trailing_tp_multiplier_monotonic <= 5);

-- === Hour blacklist per-class ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_hour_blacklist_ASIA_UTC TEXT DEFAULT '';

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_hour_blacklist_EU_UTC TEXT DEFAULT '';

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_hour_blacklist_US_UTC TEXT DEFAULT '';

-- === Per-class sizing / filter / path_eff ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_sizing_multiplier_asia_equity NUMERIC(4,2) DEFAULT 1.00
    CHECK (gainers_sizing_multiplier_asia_equity >= 0 AND gainers_sizing_multiplier_asia_equity <= 5);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_asset_class_filter_eu_equity TEXT DEFAULT 'enabled';

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_min_change_pct_eu_equity NUMERIC(5,3) DEFAULT 0.015
    CHECK (gainers_min_change_pct_eu_equity >= 0 AND gainers_min_change_pct_eu_equity <= 1);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_min_path_efficiency_EU NUMERIC(4,3) DEFAULT 0.5
    CHECK (gainers_min_path_efficiency_EU >= 0 AND gainers_min_path_efficiency_EU <= 1);

-- === News shock close (per-venue) ===
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS news_shock_close_max_age_minutes_lse INT DEFAULT 30
    CHECK (news_shock_close_max_age_minutes_lse >= 0 AND news_shock_close_max_age_minutes_lse <= 360);

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS news_shock_close_sentiment_threshold_lse NUMERIC(4,3) DEFAULT -0.6
    CHECK (news_shock_close_sentiment_threshold_lse >= -1 AND news_shock_close_sentiment_threshold_lse <= 1);

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
