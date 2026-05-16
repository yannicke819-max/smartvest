-- 0143 — Phase 5 N2 : Kelly fractional sizing par asset_class
--
-- Stocke le notional recommandé par classe, calculé par KellyRecomputeService
-- toutes les heures depuis les positions fermées 14j glissants.
--
-- - notional_usd : montant recommandé en USD (clamp [500, 3000])
-- - kelly_fraction : fraction Kelly (half-Kelly + clamp 0.25, ADR-007 §3.2)
-- - sample_size : trades fermés sur la fenêtre 14j (min 30 pour activer)
-- - win_rate_wilson_lower : borne basse 95 % Wilson (conservateur)
-- - source : 'seed_initial' / 'auto_recompute' / 'auto_recompute_no_edge'
--
-- Si kelly_fraction = 0 OU sample_size < 30 : le service consommateur fallback
-- au notional uniforme historique (~$1575). Backward-compatible 100 %.

CREATE TABLE IF NOT EXISTS asset_class_kelly_config (
  asset_class TEXT PRIMARY KEY,
  notional_usd NUMERIC NOT NULL CHECK (notional_usd >= 500 AND notional_usd <= 3000),
  kelly_fraction NUMERIC NOT NULL CHECK (kelly_fraction >= 0 AND kelly_fraction <= 0.25),
  win_rate_observed NUMERIC,
  win_rate_wilson_lower NUMERIC,
  payoff_ratio NUMERIC,
  sample_size INTEGER,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'auto_recompute',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kelly_config_computed_at
  ON asset_class_kelly_config(computed_at);

-- Seeds par défaut : fallback $1575 toutes classes, kelly_fraction=0 (= override désactivé).
-- Le service KellyRecomputeService remplacera ces seeds dès le premier run horaire
-- (typiquement à la prochaine heure ronde post-deploy).
INSERT INTO asset_class_kelly_config (asset_class, notional_usd, kelly_fraction, sample_size, source)
VALUES
  ('us_equity_large',      1575, 0, 0, 'seed_initial'),
  ('us_equity_small_mid',  1575, 0, 0, 'seed_initial'),
  ('eu_equity',            1575, 0, 0, 'seed_initial'),
  ('asia_equity',          1575, 0, 0, 'seed_initial'),
  ('crypto_major',         1575, 0, 0, 'seed_initial')
ON CONFLICT (asset_class) DO NOTHING;

-- RLS lecture autorisée pour tous (config publique non sensible), écritures
-- restreintes au service_role via les UPSERT du worker NestJS.
ALTER TABLE asset_class_kelly_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'asset_class_kelly_config' AND policyname = 'kelly_config_read_all'
  ) THEN
    CREATE POLICY "kelly_config_read_all" ON asset_class_kelly_config FOR SELECT USING (true);
  END IF;
END$$;

COMMENT ON TABLE asset_class_kelly_config IS
  'Phase 5 N2 — notional recommandé par Kelly fractionnel par asset_class. Recompute horaire.';
COMMENT ON COLUMN asset_class_kelly_config.notional_usd IS
  'Notional en USD à utiliser à l ouverture (clamp [500, 3000]).';
COMMENT ON COLUMN asset_class_kelly_config.kelly_fraction IS
  'Fraction Kelly (half-Kelly + clamp 0.25). 0 = override désactivé, fallback caller.';
COMMENT ON COLUMN asset_class_kelly_config.sample_size IS
  'Nombre de trades fermés sur la fenêtre 14j. Min 30 pour activer (ADR-007 §3.4).';
