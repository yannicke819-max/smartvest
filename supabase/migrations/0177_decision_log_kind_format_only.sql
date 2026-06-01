-- 0177 — Décision : remplacer CHECK enum strict par CHECK format-only.
--
-- Contexte : lisa_decision_log.kind était sous CHECK enum depuis 0043, étendu
-- par 0054, 0055, 0065, 0068, 0118, 0156, 0158, 0164. À chaque nouveau service
-- qui appendait un kind non-listé, l'insert silently fail (catch swallow).
--
-- Recensement au 01/06/2026, kinds émis par le code mais ABSENTS de 0164 :
--   rebound_scan_completed, lesson_auto_applied, lesson_needs_manual_review,
--   agent_wake_up_triggered, autonomous_rule_triggered,
--   daily_harvest_block_new_entries, daily_harvest_manual_sweep,
--   daily_harvest_profit_swept, daily_harvest_session_closed,
--   daily_harvest_state_transition, daily_harvest_target_hit,
--   news_aggregator_skipped_harvest_mode, gainers_expectancy_negative_watchdog,
--   gate_calibration, mechanical_close_skipped_min_profit,
--   mechanical_open_skipped_fees_aware, risk_observation,
--   anthropic_credit_exhausted, position_closed_by_lisa,
--   position_swapped_for_better_thesis, proposal_capped_by_cycle_limit,
--   proposal_failed, proposal_skipped_kill_switch, proposals_purged,
--   crypto_funding_signal, event_narrative_interpretation,
--   hour_blacklist_suggestion, losing_pattern, winning_pattern,
--   kill_switch_activated, proposal_approved, proposal_presented.
--
-- Conséquence directe observée 01/06 19:11-19:22 UTC :
--   - ReboundScannerService audit append failed (kind=rebound_scan_completed)
--   - ConfigSanityValidator findings=3 applied=0 (lesson_auto_applied rejeté
--     côté LessonAutoApply.logDecision → lesson jamais marquée applied)
--
-- Fix : DROP enum, REMPLACER par CHECK format-only (snake_case ascii) qui
-- empêche les valeurs aberrantes sans bloquer l'ajout de nouveaux kinds.
-- Ajouter un kind dans le code ne nécessite plus de migration.

ALTER TABLE public.lisa_decision_log
  DROP CONSTRAINT IF EXISTS lisa_decision_log_kind_check;

ALTER TABLE public.lisa_decision_log
  ADD CONSTRAINT lisa_decision_log_kind_check
  CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$');

COMMENT ON CONSTRAINT lisa_decision_log_kind_check ON public.lisa_decision_log IS
  '0177 — Format-only (snake_case ascii, max 64 chars). Plus d''enum strict — l''ajout d''un kind dans le code n''exige plus de migration.';
