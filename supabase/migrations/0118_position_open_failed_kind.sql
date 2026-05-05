-- Migration 0118 — Étend lisa_decision_log.kind CHECK pour observabilité scanner Gainers.
--
-- Contexte (rapport user 05/05/2026 13:55 UTC) :
-- Le scanner Gainers a tenté 4 ouvertures (021050.KO, 016360.KO ×2 cycles)
-- toutes rejetées silencieusement par paperBroker.openPosition. Le log
-- decision_log écrit uniquement le summary "Proposal X : 0 position ouverte
-- sur 1 allocation(s) — tous les gates ont rejeté" mais AUCUN détail sur la
-- cause racine (fees-aware guard ? fallback price ? insufficient cash ?).
--
-- Diagnostic actuel nécessite grep Fly logs — pas accessible à tous les users.
--
-- Cette migration ajoute le kind `position_open_failed` au CHECK constraint.
-- Le code applicatif (lisa.service.ts) écrira ce kind avec :
--   - summary : "Open SYM failed: <error message>"
--   - rationale : full error message (fees-aware/fallback/cash details)
--   - payload : { symbol, error_class, expected_gain, required_gain, ... }
--
-- Une fois mergée, les futurs rejets paperBroker seront diagnostiqués en 1
-- query SQL au lieu de fly logs grep.
--
-- Idempotente : DROP IF EXISTS + recréation avec liste exhaustive.

ALTER TABLE public.lisa_decision_log
  DROP CONSTRAINT IF EXISTS lisa_decision_log_kind_check;

ALTER TABLE public.lisa_decision_log
  ADD CONSTRAINT lisa_decision_log_kind_check
  CHECK (kind IN (
    -- Proposals & positions (0043 original)
    'proposal_generated', 'proposal_approved', 'proposal_rejected',
    'position_opened', 'position_closed', 'position_resized',
    'thesis_invalidated',
    -- Risk & lifecycle (0043 original)
    'risk_limit_breached', 'kill_switch_triggered',
    'autopilot_cycle_started', 'autopilot_cycle_completed',
    'market_regime_changed', 'analog_matched', 'user_override',
    -- Autopilot extensions (P1+)
    'autopilot_cycle_completed_error',
    'proposal_cooldown_active',
    'autopilot_paused',
    'autopilot_resumed',
    'autopilot_disabled',
    'autopilot_auto_approve_expired',
    -- Mechanical agent (P0+)
    'mechanical_open',
    'mechanical_close_stop',
    'mechanical_close_target',
    'mechanical_close_invalidated',
    'mechanical_skip',
    'mechanical_override_applied',
    -- P4.5 : alerte hedge (pas d'exécution)
    'hedge_recommendation',
    -- P5-EXEC visibility logs
    'position_skipped_duplicate_symbol',
    'position_skipped_insufficient_cash',
    'position_skipped_fallback_price',
    'proposal_capped_by_max_positions',
    -- P19β shadow logging (gainers strict 6/6)
    'gainer_shadow_466',
    'gainer_shadow_566',
    -- 0118 NEW — observabilité paper-broker silent failures
    'position_open_failed'
  ));
