-- 0055 — Extension CHECK lisa_decision_log pour P5 (Agent ↔ Lisa sync)
--
-- P5.1 introduit la boucle réflexive : l'agent mécanique peut "réveiller"
-- Lisa quand un trigger Tier 1 se déclenche (drawdown proche du kill-switch,
-- position en souffrance, VIX spike). Chaque réveil est tracé dans le
-- decision_log pour audit + rate limiting.
--
-- Nouveau kind : 'agent_wake_up_triggered'
--   payload : { trigger_type, trigger_value, threshold, context, wake_count_today }
--   triggered_by : 'risk_monitor' (existant)

alter table public.lisa_decision_log
  drop constraint if exists lisa_decision_log_kind_check;

alter table public.lisa_decision_log
  add constraint lisa_decision_log_kind_check
  check (kind in (
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
    -- P5.1 (this migration) : agent réveille Lisa sur trigger Tier 1
    'agent_wake_up_triggered'
  ));
