-- 0164 — Étend CHECK constraint lisa_decision_log.kind pour les nouveaux
-- audit kinds des services Gemini V2 livrés le 25/05/2026 :
--
--   - 'risk_manager_thesis_broken' : GeminiRiskManagerService V2 (auto-close
--     sur thèse cassée par news négative + macro)
--   - 'opportunity_scout_opened'   : GeminiOpportunityScoutService (auto-open
--     sur news macro positive, symétrique du risk manager)
--
-- Sans cette migration, les INSERT ces kinds étaient REJETÉS silencieusement
-- par la CHECK constraint (catch swallowed dans les services) → 0 audit en
-- prod malgré code actif. Bug détecté 25/05 vers 11:15 UTC.
--
-- Idempotent : DROP IF EXISTS + recréation avec liste complète existante 0158
-- + 2 nouveaux kinds.

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
    'adaptive_status_changed', 'adaptive_adjustment_applied',
    'adaptive_restore_applied', 'adaptive_kill_switch_triggered',
    -- 0156 PR #398 — Daily catalyst brief Gemini
    'daily_catalyst_brief',
    -- 0158 — OpenPositionRiskMonitorService audit
    'risk_monitor_action',
    -- 0164 NEW — Gemini V2 RiskManager + OpportunityScout (25/05/2026)
    'risk_manager_thesis_broken',
    'opportunity_scout_opened'
  ));
