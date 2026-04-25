-- Strategy optimizer : trace les runs + état du mode auto-apply.
--
-- Table optimizer_runs :
--   chaque run (Phase A/C, ou Phase B cron) y est inséré, avec leaderboard,
--   best config, score, et décision d'application si Phase B.
--
-- Table optimizer_auto_state :
--   1 seule ligne par user (UNIQUE), stocke le toggle on/off + last apply.

CREATE TABLE IF NOT EXISTS public.optimizer_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('single_shot', 'walk_forward', 'auto_apply')),
  from_date date NOT NULL,
  to_date date NOT NULL,
  initial_capital_usd numeric(14, 2) NOT NULL,
  candidates_tested int NOT NULL,
  best_score numeric(8, 4) NULL,
  best_candidate jsonb NULL,
  leaderboard jsonb NOT NULL,
  warnings text[] NOT NULL DEFAULT '{}',
  duration_ms int NOT NULL,
  -- Phase B uniquement
  apply_decision jsonb NULL,
  applied boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_optimizer_runs_user_created
  ON public.optimizer_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.optimizer_auto_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  last_run_at timestamptz NULL,
  last_apply_at timestamptz NULL,
  last_mode text NULL CHECK (last_mode IS NULL OR last_mode IN ('single_shot', 'walk_forward', 'auto_apply')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.optimizer_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.optimizer_auto_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='optimizer_runs' AND policyname='optimizer_runs_owner') THEN
    CREATE POLICY optimizer_runs_owner ON public.optimizer_runs FOR ALL
      USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='optimizer_auto_state' AND policyname='optimizer_auto_state_owner') THEN
    CREATE POLICY optimizer_auto_state_owner ON public.optimizer_auto_state FOR ALL
      USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

COMMENT ON TABLE public.optimizer_runs IS 'Trace de chaque run du strategy-optimizer (Phase A/B/C).';
COMMENT ON TABLE public.optimizer_auto_state IS 'État du mode auto-apply (Phase B) par utilisateur.';
