-- 0157_lisa_positions_thesis_health_columns.sql
-- P1 / OpenPositionRiskMonitor — capture des features au moment de l'entrée
-- pour calculer ultérieurement le thesis_health_score (cron 5 min, cf. service
-- OpenPositionRiskMonitorService).
--
-- Pas d'index : on lit ces colonnes pour chaque position ouverte une par une
-- via le PK id, pas de filtre par valeur.

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS path_eff_at_entry           NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS persistence_score_at_entry  NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS persistence_count_at_entry  TEXT,
  ADD COLUMN IF NOT EXISTS market_ch1m_at_entry        NUMERIC(8,4);

COMMENT ON COLUMN public.lisa_positions.path_eff_at_entry IS
  'overallEfficiency multi-TF au moment de l''ouverture (P1 risk monitor). NULL = position pre-feature.';
COMMENT ON COLUMN public.lisa_positions.persistence_score_at_entry IS
  'persistence_score [0,1] au moment de l''ouverture (P1 risk monitor).';
COMMENT ON COLUMN public.lisa_positions.persistence_count_at_entry IS
  'persistence_count format "X/6" (text) au moment de l''ouverture (P1 risk monitor).';
COMMENT ON COLUMN public.lisa_positions.market_ch1m_at_entry IS
  'ch1m du proxy de marché de la classe (BTCUSDT pour crypto, SPY pour US, etc.) au moment de l''ouverture, pour Sub-A momentum.';
