-- 0187 — paper_trades setup taxonomy (Step 3 chain post-#577)
--
-- Ajoute setup_kind + regime_at_entry + classifier_version pour mesurer
-- l'espérance × winrate par configuration de trade.
--
-- Recherche web 02/06/2026 — sources :
--   - Zarattini SSRN 4729284 (ORB Stocks-in-Play Sharpe 2.81)
--   - Marton & Cakir SSRN 4290787 (Hurst + SuperTrend intraday)
--   - Lopez de Prado SSRN 3517595 (Clustered Feature Importance — features orthogonales)
--   - Bailey & Lopez de Prado SSRN 2326253 (PBO) + SSRN 2460551 (Deflated Sharpe)
--   - Harvey, Liu, Zhu NBER w20592 (multiple testing : t-stat > 3.0 hurdle)
--   - Wyckoff Analytics, Dalton Markets in Profile, Bookmap order flow docs
--
-- Granularité respectée Agent 4 :
--   - Niveau 1 mesurable (gate sizing) : asset_class × regime = 4 × 3 = 12 cellules
--     → Wilson CI ±8.7% à 125 trades/cellule/mois (1500/mois SmartVest projeté)
--   - Niveau 2 exploratoire shadow : setup_kind (8 buckets) cross-cutting,
--     marqué shadow tant que n<100/cellule via classifier_version + reporting.
--
-- Forward-compatible : aucune backfill — les rows existants restent NULL,
-- mesures par cellule démarrent à partir des opens post-déploiement.

ALTER TABLE public.paper_trades
  ADD COLUMN IF NOT EXISTS setup_kind TEXT,
  ADD COLUMN IF NOT EXISTS regime_at_entry TEXT,
  ADD COLUMN IF NOT EXISTS classifier_version TEXT;

-- Index composite pour les requêtes par cellule (sizing decisions niveau-1
-- via regime × asset_class, mesures exploratoires niveau-2 via setup_kind).
CREATE INDEX IF NOT EXISTS paper_trades_setup_taxonomy_idx
  ON public.paper_trades (asset_class, regime_at_entry, setup_kind)
  WHERE setup_kind IS NOT NULL;

COMMENT ON COLUMN public.paper_trades.setup_kind IS
  'Classification setup au moment de l''open (v1 = 8 valeurs déterministes : ORB_BREAKOUT / VWAP_RECLAIM / VWAP_FADE / MOMENTUM_BREAKOUT / TREND_PULLBACK / MEAN_REVERSION / GAP_FADE / CHOP_NOISE). Dimension cross-cutting niveau-2 — utiliser shadow tant que n<100/cellule (Wilson CI > ±10%).';

COMMENT ON COLUMN public.paper_trades.regime_at_entry IS
  'Régime marché au open (3 valeurs : TREND_PORTEUR / RANGE_CALME / VOLATILE_CHOPPY). HOSTILE bloque l''open en amont (cf. MacroVeto Gemini) donc absent ici. Dimension niveau-1 sizing — croisé avec asset_class = 12 cellules (cf. Lopez de Prado / Bailey, Wilson CI ±8.7% à 125 trades/cellule/mois).';

COMMENT ON COLUMN public.paper_trades.classifier_version IS
  'Version du SetupClassifier qui a produit setup_kind + regime_at_entry. v1 = pseudo-déterministe basé sur features disponibles dans TopGainerCandidate (changePct, volume, momentum, persistence, pathEfficiency, bucket Phase 3). v2 (future) ajoutera VWAP/EMA/ATR/ADX/RSI computés.';
