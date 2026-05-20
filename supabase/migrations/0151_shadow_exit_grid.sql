-- 0151 — Shadow : grille d'exits asymétriques sur l'entrée pullback.
--
-- Contexte (analyse 20/05/2026) : un backtest crypto montre que l'espérance
-- monte de façon monotone avec la largeur du TP (TP3/SL2.5 = +0.14% net,
-- TP20/SL3 = +1.32% net) — l'asymétrie "laisser courir les gagnants, couper
-- les perdants serré" est le candidat le plus crédible pour un edge réel.
-- MAIS le backtest a un biais de sélection (on teste le passé de noms gainers
-- aujourd'hui). Seul un test FORWARD dé-biaise.
--
-- Cette colonne stocke, pour chaque entrée pullback résolue (cf. migration 0150),
-- l'issue simulée sur une GRILLE de couples (TP%, SL%) — calculée sur les mêmes
-- candles, moteur identique. Permet à l'analyse J+2 de lire quelle combinaison
-- a la meilleure espérance sur données forward réelles, sans re-déployer.
--
-- Forme : variant_exit_grid = [
--   { "tp_pct": 0.03, "sl_pct": 0.025, "pnl_pct": 0.012, "exit_reason": "TP_FULL", "exit_offset_min": 35 },
--   { "tp_pct": 0.20, "sl_pct": 0.03,  "pnl_pct": -0.03,  "exit_reason": "SL", ... }, ...
-- ]
-- ZÉRO risque capital : colonne additive, aucune position réelle ouverte.

ALTER TABLE public.gainers_v1_shadow_signals
  ADD COLUMN IF NOT EXISTS variant_exit_grid JSONB;

COMMENT ON COLUMN public.gainers_v1_shadow_signals.variant_exit_grid IS
  'Shadow asymétrie — issues simulées par couple (tp_pct, sl_pct) sur l''entrée pullback. '
  'Sert à mesurer forward (sans biais de sélection) l''edge des exits larges (TP15-20% / SL2.5-3%).';
