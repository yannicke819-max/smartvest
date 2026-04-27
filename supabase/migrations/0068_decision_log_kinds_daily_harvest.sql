-- 0068 — DAILY_HARVEST : extension kinds lisa_decision_log
--
-- Ajout des nouveaux kinds nécessaires au mode DAILY_HARVEST.
-- Pas de table dédiée pour les sweep events : tout passe par le decision_log
-- existant (hash chaîné, RLS déjà OK, lisible dans /lisa). Évite la
-- duplication d'audit.
--
-- Kinds ajoutés :
--   - daily_harvest_session_started      : nouvelle session journalière démarre
--   - daily_harvest_state_transition     : changement d'état machine
--   - daily_harvest_profit_swept         : sweep effectué (avec montant)
--   - daily_harvest_target_hit           : objectif journalier atteint
--   - daily_harvest_loss_limit_hit       : maxLossPerDay atteint
--   - daily_harvest_session_closed       : fin de journée, état figé
--   - daily_harvest_block_new_entries    : entries bloquées (state DAILY_LOCKED)
--   - daily_harvest_manual_sweep         : sweep manuel déclenché par user

ALTER TABLE public.lisa_decision_log
  DROP CONSTRAINT IF EXISTS lisa_decision_log_kind_check;

ALTER TABLE public.lisa_decision_log
  ADD CONSTRAINT lisa_decision_log_kind_check
  CHECK (kind IN (
    -- Proposals & positions (0043)
    'proposal_generated', 'proposal_approved', 'proposal_rejected',
    'position_opened', 'position_closed', 'position_resized',
    'thesis_invalidated',
    -- Risk & lifecycle (0043)
    'risk_limit_breached', 'kill_switch_triggered',
    'autopilot_cycle_started', 'autopilot_cycle_completed',
    'market_regime_changed', 'analog_matched', 'user_override',
    -- Autopilot extensions (0054)
    'autopilot_cycle_completed_error',
    'proposal_cooldown_active',
    -- Mechanical agent (0054)
    'mechanical_open',
    'mechanical_close_stop',
    'mechanical_close_target',
    'mechanical_close_invalidated',
    'mechanical_skip',
    'mechanical_override_applied',
    -- P4.5 (0054)
    'hedge_recommendation',
    -- P5.1 (0055)
    'agent_wake_up_triggered',
    -- 0065
    'position_skipped_duplicate_symbol',
    'position_skipped_insufficient_cash',
    'position_skipped_fallback_price',
    'proposal_capped_by_max_positions',
    'proposal_capped_by_cycle_limit',
    'proposal_skipped_kill_switch',
    'position_closed_by_lisa',
    'position_swapped_for_better_thesis',
    'proposals_purged',
    'proposal_failed',
    'anthropic_credit_exhausted',
    'autonomous_rule_triggered',
    -- 0068 (DAILY_HARVEST)
    'daily_harvest_session_started',
    'daily_harvest_state_transition',
    'daily_harvest_profit_swept',
    'daily_harvest_target_hit',
    'daily_harvest_loss_limit_hit',
    'daily_harvest_session_closed',
    'daily_harvest_block_new_entries',
    'daily_harvest_manual_sweep'
  ));

COMMENT ON CONSTRAINT lisa_decision_log_kind_check ON public.lisa_decision_log IS
  'Liste exhaustive des kinds autorisés. Synchronisée avec le code applicatif. Migration 0068 ajoute les 8 kinds DAILY_HARVEST.';
