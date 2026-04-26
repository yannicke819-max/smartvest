-- 0065 — Extension complète des kinds autorisés dans lisa_decision_log
--
-- Audit des kinds réellement utilisés dans le code (lisa.service.ts +
-- mechanical-trading.service.ts) révèle que 12 kinds sont utilisés mais
-- ABSENTS de la contrainte CHECK définie en 0055. Ces appels à
-- decisionLog.append() throw une violation de contrainte, mais sont
-- silencieusement avalés par le try/catch de logDecision() (lisa.service.ts:2355).
--
-- Conséquence : on perd l'audit pour ces événements (skip duplicate, swap,
-- kill-switch, fallback price, autonomous rule, etc.). Cette migration
-- ajoute tous les kinds manquants pour rétablir un audit complet.
--
-- Aucun risque de régression : on ne RETIRE aucun kind existant, on
-- AJOUTE seulement.

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
    -- P5.1 (0055) : agent réveille Lisa sur trigger Tier 1
    'agent_wake_up_triggered',
    -- ─── 0065 — Kinds utilisés dans le code mais manquants jusqu'ici ───
    -- Skips & caps côté approveProposal (lisa.service.ts)
    'position_skipped_duplicate_symbol',
    'position_skipped_insufficient_cash',
    'position_skipped_fallback_price',
    'proposal_capped_by_max_positions',
    'proposal_capped_by_cycle_limit',
    'proposal_skipped_kill_switch',
    -- Lifecycle proposal & rotation
    'position_closed_by_lisa',
    'position_swapped_for_better_thesis',
    'proposals_purged',
    'proposal_failed',
    -- Crédit Anthropic épuisé
    'anthropic_credit_exhausted',
    -- AutonomyRules évaluées par le mécanique (0061)
    'autonomous_rule_triggered'
  ));

COMMENT ON CONSTRAINT lisa_decision_log_kind_check ON public.lisa_decision_log IS
  'Liste exhaustive des kinds autorisés. Synchronisée avec lisa.service.ts et mechanical-trading.service.ts au commit a6a117b. Avant 0065, 12 kinds utilisés silencieusement avalés par le try/catch de logDecision().';
