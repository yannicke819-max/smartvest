-- 0054 — Relâche les CHECK constraints de lisa_decision_log
--
-- Contexte : le code applicatif émet des kinds et triggered_by qui n'ont
-- jamais été inclus dans le CHECK initial de 0043_lisa_tables.sql. Résultat :
--   - mechanical_open, mechanical_close_{stop,target,invalidated}, mechanical_skip,
--     mechanical_override_applied (utilisés depuis P0)
--   - autopilot_cycle_completed_error (utilisé depuis P1)
--   - proposal_cooldown_active (utilisé par lisa.service)
--   - hedge_recommendation (ajouté en P4.5)
--   - triggered_by 'mechanical_cron' (listé dans le type TS, absent du CHECK)
-- … sont tous rejetés silencieusement par Postgres (exception swallow par
-- logDecision). Donc la trace hash-chaînée a des trous depuis P0. On répare.
--
-- Cette migration est idempotente :
--   - DROP IF EXISTS sur les noms par défaut (Postgres nomme les unnamed
--     CHECK comme <table>_<column>_check par convention)
--   - Recréation avec la liste exhaustive

alter table public.lisa_decision_log
  drop constraint if exists lisa_decision_log_kind_check;

alter table public.lisa_decision_log
  drop constraint if exists lisa_decision_log_triggered_by_check;

alter table public.lisa_decision_log
  add constraint lisa_decision_log_kind_check
  check (kind in (
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
    -- Mechanical agent (P0+)
    'mechanical_open',
    'mechanical_close_stop',
    'mechanical_close_target',
    'mechanical_close_invalidated',
    'mechanical_skip',
    'mechanical_override_applied',
    -- P4.5 : alerte hedge (pas d'exécution)
    'hedge_recommendation'
  ));

alter table public.lisa_decision_log
  add constraint lisa_decision_log_triggered_by_check
  check (triggered_by in (
    'user_manual',
    'autopilot_cron',
    'risk_monitor',
    'corpus_trigger',
    'market_event',
    'mechanical_cron'
  ));
