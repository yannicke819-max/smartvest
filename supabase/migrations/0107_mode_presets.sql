-- 0107 — ADR-007 PR #207b — Mode presets (12 builtin × 3 modes + custom user)
--
-- Permet à l'utilisateur de charger en 1-clic une config pré-définie pour
-- chaque mode (Investment / Harvest / Gainers), modifiable après chargement.
--
-- Sources industry/académiques référencées par preset (Schwab Intelligent
-- Portfolios, Bogleheads 3-fund, Vanguard risk profiles, Kelly criterion,
-- pocketoption.com $1k strategies, stockstotrade RSI day trading research).

-- ─── Table builtin (seed only, read-only côté user) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.mode_presets_builtin (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mode          TEXT        NOT NULL CHECK (mode IN ('INVESTMENT', 'HARVEST', 'GAINERS')),
  preset_key    TEXT        NOT NULL,
  display_name  TEXT        NOT NULL,
  icon          TEXT        NOT NULL,
  description   TEXT        NOT NULL,
  params        JSONB       NOT NULL,
  source_ref    TEXT        NOT NULL,
  warning_level TEXT        CHECK (warning_level IN ('NONE', 'CAUTION', 'KAMIKAZE')) DEFAULT 'NONE',
  display_order INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT mode_presets_builtin_unique UNIQUE (mode, preset_key)
);

CREATE INDEX IF NOT EXISTS mode_presets_builtin_mode_order_idx
  ON public.mode_presets_builtin (mode, display_order);

-- ─── Table user-defined presets (custom save) ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_mode_presets (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID        NOT NULL,
  mode          TEXT        NOT NULL CHECK (mode IN ('INVESTMENT', 'HARVEST', 'GAINERS')),
  display_name  TEXT        NOT NULL,
  params        JSONB       NOT NULL,
  source_preset_key TEXT,           -- builtin key utilisé comme base, NULL si from scratch
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT user_mode_presets_user_name_unique UNIQUE (user_id, mode, display_name)
);

CREATE INDEX IF NOT EXISTS user_mode_presets_user_mode_idx
  ON public.user_mode_presets (user_id, mode);

ALTER TABLE public.user_mode_presets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_mode_presets'
      AND policyname = 'user_mode_presets_owner_only'
  ) THEN
    CREATE POLICY user_mode_presets_owner_only ON public.user_mode_presets
      FOR ALL USING (auth.uid() = user_id);
  END IF;
END $$;

-- ─── SEED 12 BUILTIN PRESETS (4 × 3 modes) ───────────────────────────────────

INSERT INTO public.mode_presets_builtin (mode, preset_key, display_name, icon, description, params, source_ref, warning_level, display_order) VALUES
-- INVESTMENT (long-term, Bogleheads/Schwab)
('INVESTMENT', 'CONSERVATIVE', 'Conservateur', '🛡️',
 'Retraité / capital à protéger. Allocation 20/70/10 stocks/bonds/cash.',
 '{"stocks_pct":20,"bonds_pct":70,"cash_pct":10,"rebalance":"quarterly","max_drawdown_alert_pct":10,"target_annual_return_min":0.04,"target_annual_return_max":0.06,"profile":"retirees_capital_preservation"}',
 'Schwab Intelligent Portfolios — Conservative profile. Bogleheads 3-fund retirement allocation.',
 'NONE', 1),

('INVESTMENT', 'MODERATE', 'Modéré', '⚖️',
 '40-55 ans, horizon 10-20 ans. Allocation 50/40/10.',
 '{"stocks_pct":50,"bonds_pct":40,"cash_pct":10,"rebalance":"semi_annual","max_drawdown_alert_pct":18,"target_annual_return_min":0.06,"target_annual_return_max":0.08,"profile":"midlife_balanced"}',
 'Vanguard moderate risk profile. Bogleheads target-date 2040.',
 'NONE', 2),

('INVESTMENT', 'GROWTH', 'Croissance', '📈',
 '25-40 ans, horizon 20+ ans. Allocation 75/20/5.',
 '{"stocks_pct":75,"bonds_pct":20,"cash_pct":5,"rebalance":"annual","max_drawdown_alert_pct":25,"target_annual_return_min":0.08,"target_annual_return_max":0.10,"profile":"young_growth"}',
 'Vanguard growth risk profile. Bogleheads target-date 2055.',
 'NONE', 3),

('INVESTMENT', 'AGGRESSIVE_GROWTH', 'Agressif Croissance', '🚀',
 'Jeune investisseur, tolérance DD élevée. 95/0/5 + small cap + EM + REITs.',
 '{"stocks_pct":95,"bonds_pct":0,"cash_pct":5,"include_smallcap":true,"include_emerging":true,"include_reits":true,"rebalance":"annual","max_drawdown_alert_pct":35,"target_annual_return_min":0.10,"target_annual_return_max":0.12,"profile":"aggressive_growth"}',
 'Schwab Aggressive Growth. Bogleheads 4-fund (US/Intl/Smallcap/REIT).',
 'CAUTION', 4),

-- HARVEST (daily capital discipline, swing intraday)
('HARVEST', 'CONSERVATIVE', 'Conservateur', '🛡️',
 'Débutant / apprentissage. 0.3% daily target, US open only.',
 '{"daily_target_pct":0.003,"take_profit_absolute_pct":0.015,"stop_loss_pct":0.0075,"max_trades_per_day":2,"max_position_pct":0.05,"sweep_windows_utc":["14:30-16:00"],"profile":"beginner"}',
 'pocketoption.com $1k account beginner strategy. whselfinvest DRR.',
 'NONE', 1),

('HARVEST', 'MODERATE', 'Modéré', '⚖️',
 'Intermédiaire. 0.8% daily, 3 trades max, sessions ouverture + après-midi US.',
 '{"daily_target_pct":0.008,"take_profit_absolute_pct":0.025,"stop_loss_pct":0.0125,"max_trades_per_day":3,"max_position_pct":0.08,"sweep_windows_utc":["14:30-16:00","19:00-20:30"],"profile":"intermediate"}',
 'whselfinvest Daily Range Rotation moderate. Schwab swing-trader profile.',
 'NONE', 2),

('HARVEST', 'AGGRESSIVE', 'Agressif', '🔥',
 'Expérimenté, tolérance DD. 1.5% daily, 5 trades, all sessions.',
 '{"daily_target_pct":0.015,"take_profit_absolute_pct":0.040,"stop_loss_pct":0.020,"max_trades_per_day":5,"max_position_pct":0.15,"sweep_windows_utc":["all"],"profile":"experienced"}',
 'pocketoption aggressive scalp profile.',
 'CAUTION', 3),

('HARVEST', 'SCALPER', 'Scalper', '⚡',
 'Scalper pro RSI 6 / 20-80. 2.5% daily, 10 trades, R:R 2:1 serré.',
 '{"daily_target_pct":0.025,"take_profit_absolute_pct":0.008,"stop_loss_pct":0.004,"max_trades_per_day":10,"max_position_pct":0.20,"sweep_windows_utc":["tick_mode"],"rsi_period":6,"rsi_thresholds":[20,80],"profile":"scalper_pro"}',
 'stockstotrade RSI day trading research. RSI 6 / 20-80 thresholds (Wilder 1978 short-period adaptation).',
 'CAUTION', 4),

-- GAINERS (Kelly sizing + wilson interval)
('GAINERS', 'CONSERVATIVE', 'Conservateur', '🛡️',
 'Quarter-Kelly + filtres serrés. 2 positions max, DD stop 8%.',
 '{"kelly_fraction":0.25,"min_wilson_p":0.60,"min_fibo_level":61.8,"max_position_pct":0.05,"max_concurrent_positions":2,"max_drawdown_stop_pct":0.08,"use_accept_signals_only":true,"respect_sweep_windows":true,"profile":"conservative_kelly"}',
 'Kelly criterion (Kelly 1956). Quarter-Kelly per Thorp 1969 sub-optimal but lower variance.',
 'NONE', 1),

('GAINERS', 'MODERATE', 'Modéré', '⚖️',
 'Half-Kelly standard. 3 positions, DD stop 15%. Default ADR-007 §3.2.',
 '{"kelly_fraction":0.50,"min_wilson_p":0.55,"min_fibo_level":50.0,"max_position_pct":0.10,"max_concurrent_positions":3,"max_drawdown_stop_pct":0.15,"use_accept_signals_only":true,"respect_sweep_windows":true,"profile":"half_kelly_default"}',
 'Cohen 2018 half-Kelly best practice. quantifiedstrategies.com Kelly research.',
 'NONE', 2),

('GAINERS', 'AGGRESSIVE', 'Agressif', '🔥',
 'Three-quarter Kelly. 5 positions, DD stop 22%.',
 '{"kelly_fraction":0.75,"min_wilson_p":0.52,"min_fibo_level":38.2,"max_position_pct":0.18,"max_concurrent_positions":5,"max_drawdown_stop_pct":0.22,"use_accept_signals_only":true,"respect_sweep_windows":true,"profile":"three_quarter_kelly"}',
 'kucoin.com Kelly aggressive guide. quantifiedstrategies.com 3/4 Kelly variance analysis.',
 'CAUTION', 3),

('GAINERS', 'KAMIKAZE', 'Kamikaze', '☠️',
 'FULL KELLY + filtres minimaux. ⚠️ Peut provoquer 50%+ drawdown. Backtest validation requise.',
 '{"kelly_fraction":1.0,"min_wilson_p":0.50,"min_fibo_level":23.6,"max_position_pct":0.30,"max_concurrent_positions":8,"max_drawdown_stop_pct":0.35,"use_accept_signals_only":true,"respect_sweep_windows":false,"profile":"full_kelly_kamikaze","warning":"Full Kelly variance is double half-Kelly. 50%+ drawdown probable on adverse runs. Backtest mandatory."}',
 'Kelly 1956 full Kelly (mathematically optimal but high variance). Thorp 1969 warns against in practice.',
 'KAMIKAZE', 4)

ON CONFLICT (mode, preset_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  icon = EXCLUDED.icon,
  description = EXCLUDED.description,
  params = EXCLUDED.params,
  source_ref = EXCLUDED.source_ref,
  warning_level = EXCLUDED.warning_level,
  display_order = EXCLUDED.display_order;

COMMENT ON TABLE public.mode_presets_builtin IS
  'ADR-007 PR #207b — 12 presets builtin (4 × 3 modes Investment/Harvest/Gainers). '
  'Read-only côté user, modifiable seulement via migration update. '
  'Sources documentées dans source_ref (Schwab/Bogleheads/Kelly/Thorp/whselfinvest/etc.).';

COMMENT ON TABLE public.user_mode_presets IS
  'Custom presets sauvegardés par utilisateur (via UI bouton "Sauvegarder preset"). '
  'RLS owner_only. source_preset_key référence le builtin de base si applicable.';
