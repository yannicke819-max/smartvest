-- 0146 — PR #345 : étend la CHECK constraint sur gainers_user_shadow_signals.decision
--
-- Migration originale 0134 avait une CHECK list fermée de 9 valeurs. Depuis
-- plusieurs migrations le scanner s'est mis à insérer des valeurs hors liste
-- (reject_earnings_imminent, reject_opening_buffer) qui étaient silencieusement
-- rejetées par la contrainte (les inserts shadow signals étant fire-and-forget,
-- nulle alerte n'a remonté).
--
-- Cette migration :
--   1. Réinstaure la CHECK avec une liste élargie pour les 2 valeurs déjà émises
--      par le code (réparation silencieuse — les futurs inserts succeederont).
--   2. Ajoute les 2 nouvelles valeurs PR #345 (filtres TwelveData) :
--        - reject_supertrend_down : Supertrend 30m direction=down (us_equity)
--        - reject_rsi_overbought  : RSI 5m > 75 (crypto_major)
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
    -- Valeurs déjà émises par le scanner (insert silencieusement rejeté avant 0146)
    'reject_earnings_imminent',
    'reject_opening_buffer',
    -- PR #345 — filtres TwelveData
    'reject_supertrend_down',
    'reject_rsi_overbought'
  ));

COMMENT ON CONSTRAINT gainers_user_shadow_signals_decision_check
  ON public.gainers_user_shadow_signals IS
  'PR #345 — étend la liste pour 4 valeurs (2 réparation silent failure + 2 nouvelles filtres TwelveData).';
