-- Migration 0186 — Log persistant des market snapshots
--
-- Actuellement fetchMarketSnapshot() retourne une snapshot in-memory consommée
-- par le cycle Lisa puis perdue. Aucune traçabilité historique :
--   - "Qu'est-ce que TRADER voyait au moment de sa décision X ?"
--   - "Quand le VIX a-t-il spiké aujourd'hui ?"
--   - "Quel pourcentage du temps DXY était en fallback la semaine dernière ?"
--
-- Cette table append-only stocke 1 snapshot par appel (1 / cycle Lisa = ~ 1
-- per 5 min). Rétention 30 jours suffit (analyses court-terme).

CREATE TABLE IF NOT EXISTS lisa_market_snapshot_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Snapshot complet en JSONB pour ne pas avoir à migrer les colonnes à
  -- chaque nouveau field. Lecture : ->>vix, ->>dxy, ->'dataQuality'->'live'.
  snapshot JSONB NOT NULL,
  -- Quick-access champs pour requêtes filtrées sans parser le JSONB (les 4
  -- indicateurs dont on a le plus besoin pour grep / chart historique).
  vix NUMERIC,
  dxy NUMERIC,
  us10y NUMERIC,
  brent NUMERIC,
  -- Compteur data quality pour alertes (si fallback_count > 3 → degraded).
  fallback_count INT,
  proxy_count INT
);

CREATE INDEX IF NOT EXISTS idx_market_snapshot_captured_at
  ON lisa_market_snapshot_log (captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_market_snapshot_fallback_count
  ON lisa_market_snapshot_log (fallback_count, captured_at DESC)
  WHERE fallback_count > 0;

COMMENT ON TABLE lisa_market_snapshot_log IS
  'Append-only log des market snapshots Lisa (1 par cycle ~5min). Permet diagnostic historique macro + data quality. Rétention 30j (cleanup cron à venir).';

-- Cleanup auto > 30 jours via fonction. Exécution déférée à un cron applicatif
-- (pas pg_cron pour éviter dépendance extension).
COMMENT ON COLUMN lisa_market_snapshot_log.fallback_count IS
  'Nombre d''indicateurs en fallback (DXY/Gold/Brent/Silver/HY/IG/...). Si >3, le snapshot est "degraded" → décision LLM doit être prudente.';
