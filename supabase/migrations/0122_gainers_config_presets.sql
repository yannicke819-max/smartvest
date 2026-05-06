-- 0122_gainers_config_presets
--
-- PR #265 — Sauvegardes nommées de config gainers.
-- Permet à l'utilisateur de sauvegarder l'état complet de sa config
-- (TP/SL/persistence/path/universe/rotation/etc.) sous un nom et
-- de la recharger d'un clic.
--
-- Use cases : tester différentes stratégies (Conservateur / Aggressif /
-- Crypto-only) et basculer selon les conditions de marché.

CREATE TABLE IF NOT EXISTS public.gainers_config_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  settings JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(portfolio_id, name)
);

CREATE INDEX IF NOT EXISTS gainers_config_presets_portfolio_idx
  ON public.gainers_config_presets(portfolio_id);

ALTER TABLE public.gainers_config_presets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gainers_config_presets'
      AND policyname = 'gainers_config_presets_owner'
  ) THEN
    CREATE POLICY gainers_config_presets_owner ON public.gainers_config_presets
      FOR ALL USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

COMMENT ON TABLE public.gainers_config_presets IS
  'PR #265 — Sauvegardes nommées de config gainers (TP/SL/gates/universe/rotation/etc.).';
