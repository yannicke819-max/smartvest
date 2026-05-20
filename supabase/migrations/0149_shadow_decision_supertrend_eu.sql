-- 0149 — PR #368 : étend la CHECK constraint gainers_user_shadow_signals.decision
--
-- Bug latent : la migration 0146 (PR #345) a réinstauré la CHECK list mais a
-- OUBLIÉ 'reject_supertrend_asia_down' (PR #360) — donc depuis PR #360 les
-- shadow signals asia-supertrend sont silencieusement rejetés par la contrainte
-- (inserts fire-and-forget → aucune alerte). Cette migration répare ça ET
-- ajoute la nouvelle valeur PR #368 :
--   - reject_supertrend_asia_down : Supertrend 30m down (asia_equity) — réparation PR #360
--   - reject_supertrend_eu_down   : Supertrend 30m down (eu_equity)   — nouveau PR #368
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
    -- PR #360 (réparation silent failure) + PR #368
    'reject_supertrend_asia_down',
    'reject_supertrend_eu_down'
  ));

COMMENT ON CONSTRAINT gainers_user_shadow_signals_decision_check
  ON public.gainers_user_shadow_signals IS
  'PR #368 — ajoute reject_supertrend_asia_down (répare PR #360) + reject_supertrend_eu_down.';
