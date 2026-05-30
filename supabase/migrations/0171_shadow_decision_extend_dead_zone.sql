-- 0171 — Extend gainers_user_shadow_signals.decision CHECK constraint.
--
-- Contexte : depuis migration 0149 (PR #368), de nombreuses valeurs ShadowDecision
-- (TS) ont été ajoutées sans étendre la contrainte DB — les inserts fire-and-forget
-- correspondants étaient silencieusement REJECT par PostgreSQL → trou observability.
--
-- Cette migration :
--   1. Répare le trou : ajoute toutes les valeurs présentes dans gainers-user-shadow.service.ts
--      mais absentes de la contrainte 0149 (reject_overextended, reject_hour_*, reject_liquidity,
--      reject_reentry_downtrend, reject_market_closed, reject_signal_stale, reject_volatile_regime,
--      reject_stagflation_hedge_guard, reject_post_news_fresh_strong_pos)
--   2. Nouveau : ajoute `reject_dead_zone` (analyse 3 semaines 27/05/2026 — buckets
--      change_pct 4-8% et 15-20% sous-performent structurellement, Σpnl -28% et -111%)
--
-- Idempotent : DROP IF EXISTS + ADD.

ALTER TABLE public.gainers_user_shadow_signals
  DROP CONSTRAINT IF EXISTS gainers_user_shadow_signals_decision_check;

ALTER TABLE public.gainers_user_shadow_signals
  ADD CONSTRAINT gainers_user_shadow_signals_decision_check
  CHECK (decision IN (
    'accept',
    'reject_path_eff',
    'reject_persistence',
    'reject_cooldown',
    'reject_post_sl_cooldown',
    'reject_p_win',
    'reject_budget_cap',
    'reject_no_tf_data',
    'reject_other',
    'reject_earnings_imminent',
    'reject_opening_buffer',
    'reject_supertrend_down',
    'reject_rsi_overbought',
    'reject_supertrend_asia_down',
    'reject_supertrend_eu_down',
    -- Réparation 0171 : valeurs ajoutées en code mais oubliées en DB
    'reject_overextended',
    'reject_hour_blacklisted',
    'reject_hour_not_whitelisted',
    'reject_liquidity',
    'reject_reentry_downtrend',
    'reject_market_closed',
    'reject_signal_stale',
    'reject_volatile_regime',
    'reject_stagflation_hedge_guard',
    'reject_post_news_fresh_strong_pos',
    -- Nouveau gate dead-zone (analyse stats 06-27/05/2026)
    'reject_dead_zone'
  ));

COMMENT ON CONSTRAINT gainers_user_shadow_signals_decision_check
  ON public.gainers_user_shadow_signals IS
  '0171 — réparation observability + ajout reject_dead_zone (anti chase 4-8%/15-20%).';
