-- 0190 — Granularité reject_* pour gates anti-OKLO (CLIMAX_RUN, VERTICAL_PUMP, CHOP_LONG_TF).
--
-- Contexte : post-mortem OKLO 03/06/2026, 4 gates ajoutés (cf.
-- blow-off-gates.helper.ts + PR #584). Trois d'entre eux écrivent actuellement
-- 'reject_other' ou 'reject_path_eff' dans gainers_user_shadow_signals,
-- masquant la dissection précise des rejets dans l'audit.
--
-- Audit nuit 03→04/06 : 75 reject_other Asia sur 126 candidats, impossible
-- de dire si c'est CLIMAX_RUN ou VERTICAL_PUMP ou CHOP_NOISE legacy qui mord.
--
-- Cette migration ajoute :
--   - reject_climax_run     : tf30m ≈ tf5m + tf5m ≥ 5% (plateau pré-burst)
--   - reject_vertical_pump  : ch1m/tf5m > 0.5 + tf5m ≥ 5% (concentration last minute)
--   - reject_chop_long_tf   : tf1h OU tf30m pathEff < threshold (chop structurel)
--   - reject_top_tick_drift : (déjà via decision_log mais pour cohérence shadow signals)
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
    'reject_dead_zone',
    -- Nouveau 0190 — granularité gates anti-OKLO (PR #584 blow-off-gates.helper)
    'reject_climax_run',
    'reject_vertical_pump',
    'reject_chop_long_tf',
    'reject_top_tick_drift'
  ));

COMMENT ON CONSTRAINT gainers_user_shadow_signals_decision_check
  ON public.gainers_user_shadow_signals IS
  '0190 — granularité reject_climax_run / reject_vertical_pump / reject_chop_long_tf / reject_top_tick_drift (post-OKLO).';
