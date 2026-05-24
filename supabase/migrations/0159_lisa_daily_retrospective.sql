-- 0159_lisa_daily_retrospective.sql
-- Feature #3 — Rétrospective journalière narrative générée par Gemini Pro.
--
-- À 22:00 UTC chaque jour, un cron aggrège la journée (opens, closes, verdicts
-- risk-monitor, conviction sizing, correlation rejections, PnL) et envoie
-- à Gemini Pro qui produit 1 paragraphe en français résumant la journée
-- et suggérant des ajustements éventuels.
--
-- Append-only, retention 90j (cleanup cron à wirer plus tard si volume > 1000).

CREATE TABLE IF NOT EXISTS public.lisa_daily_retrospective (
  id              BIGSERIAL PRIMARY KEY,
  retrospective_date DATE NOT NULL,
  portfolio_id    UUID REFERENCES public.portfolios(id) ON DELETE CASCADE,
  -- Stats du jour (snapshot complet, JSON pour extensibilité future)
  stats_json      JSONB NOT NULL,
  -- Narration générée par Gemini Pro (français, ~150 mots typique)
  narrative       TEXT NOT NULL,
  -- Suggestions extraites (1 par ligne, parsées du narrative ou structurées)
  suggestions     JSONB,
  -- Sentiment global : 'positif' | 'neutre' | 'mixte' | 'negatif'
  sentiment       TEXT CHECK (sentiment IN ('positif', 'neutre', 'mixte', 'negatif')),
  -- Audit
  llm_provider    TEXT,           -- ex 'gemini-pro' / 'gemini-flash'
  llm_cost_usd    NUMERIC(8,5),   -- ex 0.00120
  llm_latency_ms  INT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Une seule rétro par portfolio par jour
  CONSTRAINT lisa_daily_retrospective_unique UNIQUE (portfolio_id, retrospective_date)
);

CREATE INDEX IF NOT EXISTS idx_ldr_portfolio_date
  ON public.lisa_daily_retrospective (portfolio_id, retrospective_date DESC);

CREATE INDEX IF NOT EXISTS idx_ldr_generated_at
  ON public.lisa_daily_retrospective (generated_at DESC);

ALTER TABLE public.lisa_daily_retrospective ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'lisa_daily_retrospective'
      AND policyname = 'lisa_daily_retrospective_owner_select'
  ) THEN
    CREATE POLICY lisa_daily_retrospective_owner_select ON public.lisa_daily_retrospective
      FOR SELECT USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.lisa_daily_retrospective IS
  'Feature #3 — Rétrospective journalière narrative générée par Gemini Pro à 22:00 UTC. '
  'Append-only, 1 ligne/portfolio/jour, rétention 90j.';
