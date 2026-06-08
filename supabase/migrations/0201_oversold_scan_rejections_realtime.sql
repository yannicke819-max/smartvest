-- 0201 — Colonnes métriques du chemin REAL-TIME OHLC pour oversold_scan_rejections.
--
-- Pour l'EU, les bougies intraday 5m (TD + EODHD) sont gelées sur vendredi
-- (P19-staleness) → le scanner bascule sur un chemin real-time OHLC (EODHD
-- /api/real-time, frais) qui reconstruit le rebond sans série :
--   reboundFromLow = (close - low) / low
--   rangePos       = (close - low) / (high - low)
--   dayChg         = (close - prevClose) / prevClose
--
-- Ces métriques n'ont pas d'équivalent dans les colonnes "candles"
-- (rebound_pct / trend_15m_pct / volume_ratio / bottom_bar_idx). On les ajoute
-- pour que l'analyse de gate (mission "gate qui rate les pépites") reste
-- exploitable sur le chemin real-time. `analysis_mode` distingue les 2 chemins.

ALTER TABLE oversold_scan_rejections
  ADD COLUMN IF NOT EXISTS analysis_mode       TEXT,           -- 'candles' | 'realtime_ohlc'
  ADD COLUMN IF NOT EXISTS rebound_from_low_pct NUMERIC(8,3),  -- (close-low)/low ×100
  ADD COLUMN IF NOT EXISTS range_pos_pct        NUMERIC(8,3),  -- (close-low)/(high-low) ×100 ∈ [0,100]
  ADD COLUMN IF NOT EXISTS day_chg_pct          NUMERIC(8,3);  -- (close-prevClose)/prevClose ×100
