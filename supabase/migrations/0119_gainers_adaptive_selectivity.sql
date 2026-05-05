-- Migration 0119 — Gainers Adaptive Selectivity (PR #243).
--
-- Ajoute les colonnes nécessaires au service GainersAdaptiveSelectivity qui
-- ajuste dynamiquement les seuils du scanner selon le trajectory_status
-- (EN_RETARD assouplit / EN_AVANCE no-op / HORS_TRAJECTOIRE scanner OFF).
--
-- Spec utilisateur (05/05/2026 14:30 UTC) :
--   - EN_RETARD (<70% cible) : persistence −0.05, path_eff −0.05,
--     max_per_cycle +1, cooldown ÷2
--   - EN_AVANCE (>130% cible) : aucune modif (préserve le cap user)
--   - HORS_TRAJECTOIRE (réalisé négatif) : autopilot=false + alarm UI
--   - DANS_LE_PLAN : restore user values (snapshot dans adaptive_user_*)
--   - Pas de reset 00:00 UTC (ajustements persistent)
--
-- Snapshot pattern : quand l'adaptive entre en EN_RETARD (transition depuis
-- DANS_LE_PLAN ou HORS_TRAJECTOIRE), on snapshot les valeurs USER courantes
-- avant d'assouplir. Au retour en DANS_LE_PLAN, on restore depuis snapshot.

ALTER TABLE public.lisa_session_configs
  -- Toggle opt-in user (default false : feature désactivée par défaut)
  ADD COLUMN IF NOT EXISTS gainers_adaptive_enabled BOOLEAN DEFAULT false,
  -- Flag interne service : true quand des seuils sont actuellement assouplis
  ADD COLUMN IF NOT EXISTS gainers_adaptive_active BOOLEAN DEFAULT false,
  -- Snapshot des valeurs user originales (avant assouplissement)
  -- Restaurés quand trajectory_status retourne DANS_LE_PLAN
  ADD COLUMN IF NOT EXISTS gainers_adaptive_snapshot_persistence NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS gainers_adaptive_snapshot_path_eff NUMERIC(4,3),
  ADD COLUMN IF NOT EXISTS gainers_adaptive_snapshot_max_per_cycle INT,
  ADD COLUMN IF NOT EXISTS gainers_adaptive_snapshot_cooldown INT,
  -- Dernier status calculé (pour UI bandeau + audit)
  ADD COLUMN IF NOT EXISTS gainers_trajectory_status TEXT
    CHECK (gainers_trajectory_status IS NULL OR gainers_trajectory_status IN
      ('EN_AVANCE', 'DANS_LE_PLAN', 'EN_RETARD', 'HORS_TRAJECTOIRE')),
  ADD COLUMN IF NOT EXISTS gainers_trajectory_status_at TIMESTAMPTZ,
  -- Realised 7d % calculé au dernier cycle (pour UI tooltip + debug)
  ADD COLUMN IF NOT EXISTS gainers_realised_7d_pct NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS gainers_target_7d_pct NUMERIC(8,4);

-- Étend le CHECK sur lisa_decision_log.kind pour les nouveaux events adaptive.
-- Idempotent : DROP IF EXISTS + recréation.
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
    'adaptive_status_changed',          -- transition trajectory_status
    'adaptive_adjustment_applied',      -- assouplissement EN_RETARD appliqué
    'adaptive_restore_applied',         -- restore DANS_LE_PLAN depuis snapshot
    'adaptive_kill_switch_triggered'    -- HORS_TRAJECTOIRE → autopilot=false
  ));

COMMENT ON COLUMN public.lisa_session_configs.gainers_adaptive_enabled IS
  'Toggle opt-in pour le service GainersAdaptiveSelectivity. Default false.';
COMMENT ON COLUMN public.lisa_session_configs.gainers_trajectory_status IS
  'Dernier trajectory_status calculé par le service adaptive (cron 5min).';
