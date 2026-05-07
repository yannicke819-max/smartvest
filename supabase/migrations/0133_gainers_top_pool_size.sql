-- 0133_gainers_top_pool_size
--
-- PR #278 — Rend configurable la taille du pool top scanner.
--
-- Avant : `TOP_POOL_SIZE_PER_PORTFOLIO = 10` hardcoded dans
-- TopGainersScannerService.scanPortfolio. Cette taille détermine combien
-- de candidats arrivent au stage "open evaluation" après le filtrage
-- universe + session.
--
-- Constat user : avec pool 10, le top est trusté par les Asia score 1.0
-- en heures Asia closed (filtrés ensuite). Les EU/Swiss avec scores
-- 0.55-0.65 arrivent jamais à l'évaluation. Pool 20 inclurait HUBN.SW etc.
--
-- Range : 5..50 (5 = très selectif, 50 = très permissif).
-- Default 10 (back-compat).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_top_pool_size INT DEFAULT 10
  CHECK (gainers_top_pool_size IS NULL OR
         (gainers_top_pool_size >= 5 AND gainers_top_pool_size <= 50));

COMMENT ON COLUMN public.lisa_session_configs.gainers_top_pool_size IS
  'PR #278 — Taille du pool top scanner (TOP_POOL_SIZE_PER_PORTFOLIO). '
  'Default 10. Range 5..50. Plus haut = inclut plus de candidats EU/Swiss '
  'sous-rankés par les Asia top scoring.';
