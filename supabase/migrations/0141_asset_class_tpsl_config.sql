-- 0141 — Phase 5 N1 PR-2 : matrice TP/SL par asset_class
--
-- Table read-only en runtime pour PR-2. UI d'édition arrive en PR-5
-- (ALTER policy à ajouter à ce moment).
--
-- Source seed : baseline 4j mesurée 12-16 mai (tp_avg_pct / sl_avg_pct par classe)
-- - asia_equity   : laisse courir (TP 3% pour capturer la persistance des KO/SHE)
-- - eu_equity     : SL élargi 1.8% (slippage Europe matin)
-- - us_equity_large : statu quo serré (liquidité forte)
-- - us_equity_small_mid : milieu (volatilité moyenne)
-- - crypto_major  : serré (forte volatilité, capture rapide)
--
-- Unités : tp_pct / sl_pct stockés en décimal (0.030 = 3 %). Le runtime
-- convertit en pourcentage (×100) pour alignement avec stopPct/tpPct existants.

CREATE TABLE IF NOT EXISTS asset_class_tpsl_config (
  asset_class text PRIMARY KEY,
  tp_pct numeric(6,4) NOT NULL CHECK (tp_pct > 0 AND tp_pct <= 0.10),
  sl_pct numeric(6,4) NOT NULL CHECK (sl_pct < 0 AND sl_pct >= -0.05),
  notes text,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO asset_class_tpsl_config (asset_class, tp_pct, sl_pct, notes) VALUES
  ('asia_equity',         0.030, -0.013, 'Baseline tp_avg_pct 7j = 2.8% → TP 3% pour laisser courir (QW#5)'),
  ('eu_equity',           0.025, -0.018, 'sl_avg_pct 7j = -1.7% slippage Europe → SL élargi 1.8%'),
  ('us_equity_large',     0.025, -0.013, 'Baseline statu quo, SL serré (liquidité forte)'),
  ('us_equity_small_mid', 0.028, -0.015, 'TP légèrement élargi, SL milieu (volatilité moyenne)'),
  ('crypto_major',        0.022, -0.012, 'TP/SL serrés (forte volatilité, capture rapide)')
ON CONFLICT (asset_class) DO NOTHING;

-- RLS : lecture seule pour le service runtime (service_role bypass RLS de toute façon,
-- mais on garde la policy explicite pour future UI).
ALTER TABLE asset_class_tpsl_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_read ON asset_class_tpsl_config FOR SELECT USING (true);

COMMENT ON TABLE asset_class_tpsl_config IS
  'PR-2 v2 — matrice TP/SL par asset_class, read-only en runtime, UI = PR-5.';
COMMENT ON COLUMN asset_class_tpsl_config.tp_pct IS
  'Take-profit cible en décimal (0.030 = 3 %). Range (0, 0.10].';
COMMENT ON COLUMN asset_class_tpsl_config.sl_pct IS
  'Stop-loss en décimal négatif (-0.013 = -1.3 %). Range [-0.05, 0).';
