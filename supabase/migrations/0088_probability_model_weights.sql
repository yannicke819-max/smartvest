-- P9 — BAYESIAN PERSISTENCE PROBABILITY
--
-- Stocke les poids du modèle logistic regression entraîné sur paper_trades.
-- Une ligne par version. La version courante = celle avec trained_at MAX.
--
-- Champs métriques :
--   - sample_size : nombre de trades fermés utilisés pour l'entraînement
--   - auc_roc     : AUC sur l'ensemble d'entraînement (fallback in-sample,
--                   pas de split train/test pour ce v1 — le sample size est
--                   généralement faible, le risque de overfit est mitigé par
--                   la régularisation L2 dans le fitter)
--   - accuracy    : (TP+TN)/total à threshold 0.5
--
-- weights JSONB :
--   { "intercept": -1.8, "persistenceCount": 0.62, "volRatio": 0.18,
--     "rsi": 0.04, "closeToHigh": 0.31, ... }
--
-- Garde-fous :
--   - sample_size < 30        → fallback P8 dur (pas de fit, marqueur degraded)
--   - auc_roc < 0.55          → fit rejeté (modèle non discriminant)
--   - nouveau fit dégrade > 5%  → optionnel, conservation v.previous

CREATE TABLE IF NOT EXISTS public.probability_model_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL,
  weights jsonb NOT NULL,
  trained_at timestamptz NOT NULL DEFAULT now(),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  auc_roc numeric(4, 3),
  accuracy numeric(4, 3),
  precision_at_threshold numeric(4, 3),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS probability_model_weights_trained_at_idx
  ON public.probability_model_weights (trained_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS probability_model_weights_version_idx
  ON public.probability_model_weights (version);

ALTER TABLE public.probability_model_weights ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'probability_model_weights'
      AND policyname = 'probability_model_weights_select_authenticated'
  ) THEN
    CREATE POLICY probability_model_weights_select_authenticated
      ON public.probability_model_weights
      FOR SELECT USING (auth.role() = 'authenticated');
  END IF;
END $$;

COMMENT ON TABLE public.probability_model_weights IS
  'P9 — Poids du modèle logistic regression (P(win) | features). Refit hebdo via cron Sunday 02:00 UTC. Fallback P8 dur si sample_size<30 OU auc<0.55. Append-only, version courante = trained_at MAX.';
