-- 0160_feature_ab_snapshot.sql
-- Miracle #4 — Auto-tuning A/B continu.
--
-- Chaque jour à 00:30 UTC, snapshot l'état des feature flags actives (lecture
-- env via ConfigService) + le PnL réalisé du jour. Permet ensuite d'analyser
-- statistiquement quelles features sont ON les jours rentables vs perdants.
--
-- Append-only, retention 365 jours (1 ligne/portfolio/jour, low volume).

CREATE TABLE IF NOT EXISTS public.feature_ab_snapshot (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_date   DATE NOT NULL,
  portfolio_id    UUID REFERENCES public.portfolios(id) ON DELETE CASCADE,
  -- Flags actifs (subset des features Miracle 1-4 + risk monitor + correlation + sizing)
  flags_json      JSONB NOT NULL,
  -- PnL du jour (cf. lisa_positions closed sur la date)
  pnl_usd         NUMERIC(12,4),
  n_opens         INT,
  n_closes        INT,
  n_winners       INT,
  n_losers        INT,
  -- Compteur d'actions de chaque service (extrait de lisa_decision_log)
  rm_actions_count INT,
  cg_rejections_count INT,
  ee_fades_count   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT feature_ab_snapshot_unique UNIQUE (portfolio_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_feature_ab_date
  ON public.feature_ab_snapshot (snapshot_date DESC);

CREATE INDEX IF NOT EXISTS idx_feature_ab_portfolio_date
  ON public.feature_ab_snapshot (portfolio_id, snapshot_date DESC);

ALTER TABLE public.feature_ab_snapshot ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'feature_ab_snapshot'
      AND policyname = 'feature_ab_owner_select'
  ) THEN
    CREATE POLICY feature_ab_owner_select ON public.feature_ab_snapshot
      FOR SELECT USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.feature_ab_snapshot IS
  'Miracle #4 — Snapshot quotidien (00:30 UTC) des feature flags actifs + PnL '
  'du jour. Permet à FeatureABTuningService d''analyser quelles features '
  'corrèlent avec les jours rentables (sliding window 14j).';
