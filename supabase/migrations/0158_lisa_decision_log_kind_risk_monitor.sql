-- 0158_lisa_decision_log_kind_risk_monitor.sql
-- Bug #2 fix : OpenPositionRiskMonitorService.auditAction utilisait
-- 'position_opened' par défaut (kind autorisé) faute de kind dédié, ce qui
-- polluait les analytics "dernières positions ouvertes".
--
-- Ajoute 'risk_monitor_action' à la liste autorisée. Le service ré-utilise
-- ce kind pour tout audit (CLOSE_NOW, TIGHTEN_SL, RAISE_TP, MOMENTUM_RIDE).
-- Le verdict détaillé est encodé dans payload.verdict.
--
-- Idempotent : DROP IF EXISTS + recréation avec liste complète.

ALTER TABLE public.lisa_decision_log
  DROP CONSTRAINT IF EXISTS lisa_decision_log_kind_check;

ALTER TABLE public.lisa_decision_log
  ADD CONSTRAINT lisa_decision_log_kind_check
  CHECK (kind IN (
    -- Original 0043
    'proposal_generated', 'proposal_approved', 'proposal_rejected',
    'position_opened', 'position_closed', 'position_resized',
    'thesis_invalidated', 'risk_limit_breached', 'kill_switch_triggered',
    'autopilot_cycle_started', 'autopilot_cycle_completed',
    'market_regime_changed', 'analog_matched', 'user_override',
    -- Autopilot extensions
    'autopilot_cycle_completed_error', 'proposal_cooldown_active',
    'autopilot_paused', 'autopilot_resumed', 'autopilot_disabled',
    'autopilot_auto_approve_expired',
    -- Mechanical agent
    'mechanical_open', 'mechanical_close_stop', 'mechanical_close_target',
    'mechanical_close_invalidated', 'mechanical_skip', 'mechanical_override_applied',
    -- Hedge
    'hedge_recommendation',
    -- P5-EXEC visibility
    'position_skipped_duplicate_symbol', 'position_skipped_insufficient_cash',
    'position_skipped_fallback_price', 'proposal_capped_by_max_positions',
    -- P19β shadow
    'gainer_shadow_466', 'gainer_shadow_566',
    -- 0118 observabilité
    'position_open_failed',
    -- 0119 adaptive selectivity
    'adaptive_status_changed',
    'adaptive_adjustment_applied',
    'adaptive_restore_applied',
    'adaptive_kill_switch_triggered',
    -- 0156 PR #398 — Daily catalyst brief Gemini
    'daily_catalyst_brief',
    -- 0158 — OpenPositionRiskMonitorService audit
    'risk_monitor_action'
  ));
