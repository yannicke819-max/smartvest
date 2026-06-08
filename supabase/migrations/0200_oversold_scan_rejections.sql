-- 0200 — Logging per-candidat du scanner oversold (mission "gate qui rate les pépites").
--
-- PROBLÈME : le scan intraday bucketise tous les rejets en un seul compteur
-- `rejected_rebound` dans le decision_log — sans dire QUEL des 4 sous-gates
-- (rebound% / trend15m / bottom-timing / volRatio) a rejeté chaque candidat,
-- ni les valeurs réelles des métriques. Impossible de savoir si un gate est
-- trop strict (= rate des pépites) ou rejette à raison (= du bruit).
--
-- SOLUTION : table shadow append-only qui enregistre, pour CHAQUE candidat de
-- CHAQUE scan, le verdict gate + les métriques. Permet ensuite de calculer le
-- "regret par gate" (% de rejets qui ont rebondi APRÈS) en joignant les prix
-- forward EODHD. C'est l'outil fondateur de la mission de calibration.
--
-- Append-only, jamais d'UPDATE. Rétention : purge > 30j via cron à venir (faible
-- volume : ~quelques dizaines de rows / scan / portfolio / heure).

CREATE TABLE IF NOT EXISTS oversold_scan_rejections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id    UUID NOT NULL,
  scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_phase      TEXT NOT NULL DEFAULT 'intraday',   -- 'intraday' | 'daily'
  universe        TEXT,
  region          TEXT,                                -- 'US' | 'EU'
  symbol          TEXT NOT NULL,

  -- Contexte bande (drop EOD qui a qualifié le candidat)
  drop_pct        NUMERIC(8,3),                        -- (closeJ/closeJ-1 - 1)×100
  close_j         NUMERIC(14,4),                       -- close de référence (creux d'entrée)

  -- Verdict
  outcome         TEXT NOT NULL,                       -- 'opened' | 'rejected'
  reject_stage    TEXT,                                -- 'no_candles' | 'insufficient_bars'
                                                       -- | 'analysis_null' | 'rebound_filter' (NULL si opened)
  reject_reasons  JSONB,                               -- array de strings (gates échoués, ex: ["rebound=0.42% < 1.5%"])

  -- Métriques intraday au moment du scan (NULL si pas de candles)
  current_price   NUMERIC(14,4),
  rebound_pct     NUMERIC(8,3),                        -- (current - low_60min) / low × 100
  trend_15m_pct   NUMERIC(8,3),                        -- slope 3 dernières bars 5m
  volume_ratio    NUMERIC(8,3),                        -- vol_last_30m / vol_first_30m
  bottom_bar_idx  INT,                                 -- idx du low (0=plus ancien, n-1=courant)
  bars_count      INT
);

CREATE INDEX IF NOT EXISTS idx_oversold_scan_rejections_scanned_at
  ON oversold_scan_rejections (scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_oversold_scan_rejections_portfolio
  ON oversold_scan_rejections (portfolio_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_oversold_scan_rejections_symbol
  ON oversold_scan_rejections (symbol, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_oversold_scan_rejections_stage
  ON oversold_scan_rejections (reject_stage);
