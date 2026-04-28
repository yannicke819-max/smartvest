-- P3-B — Table backtest_runs : trace persistante des runs de backtest
-- rebound-tp pour audit longitudinal et comparaison historique.
--
-- Une row par invocation `npm run backtest:rebound`. Permet :
--   - de comparer expectancy/hit-rate à travers les runs successifs
--   - de tracer la décision GO/NO-GO qui a déclenché un changement de
--     defaults env (e.g., rebound-tp-scanner.service.ts ENV REBOUND_*)
--   - d'audit MIFID-friendly : "à 14:32 le 28/04/26, sur SP500 2024-04 →
--     2026-04, hit-rate TP1+ 58.3% expectancy +1.2%, GO → defaults
--     RSI=30, vol=1.5 inchangés"

CREATE TABLE IF NOT EXISTS public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  -- Univers testé (sp500 / nasdaq100 / both).
  universe text NOT NULL,
  -- Fenêtre temporelle ISO YYYY-MM-DD.
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  -- Snapshot de la cfg scanRebound utilisée (RSI/BB/dd/vol/TP/SL/timeStop).
  cfg_json jsonb NOT NULL,
  -- Métriques calculées (BacktestMetrics serialized).
  metrics_json jsonb NOT NULL,
  -- Verdict GO/NO_GO.
  verdict text NOT NULL CHECK (verdict IN ('GO', 'NO_GO')),
  -- Variant sélectionnée si --auto-tune (default/strict/rsi_25/vol_2_0/dd_20).
  selected_variant text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backtest_runs_run_at_desc_idx
  ON public.backtest_runs (run_at DESC);

CREATE INDEX IF NOT EXISTS backtest_runs_verdict_idx
  ON public.backtest_runs (verdict, run_at DESC);

-- RLS — append-only audit, lecture pour user authentifié (analyse via UI).
-- Le CLI utilise service_role qui bypasse RLS.
ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'backtest_runs'
      AND policyname = 'backtest_runs_select_authenticated'
  ) THEN
    CREATE POLICY backtest_runs_select_authenticated ON public.backtest_runs
      FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

COMMENT ON TABLE public.backtest_runs IS
  'P3-B — trace audit des runs de backtest rebound-tp. cfg_json + metrics_json + verdict pour reconstituer chaque décision GO/NO_GO et son contexte (TP1 hit-rate, expectancy, distribution).';
