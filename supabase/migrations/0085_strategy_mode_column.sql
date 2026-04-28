-- P7-MODE-GAINERS-BADGE — Mode opératoire unifié 3-way (UI badge).
--
-- Avant : MacroModeService dérive le mode (INVESTMENT/HARVEST) de l'aggregat
-- (profile, capital_discipline_mode). TopGainersScannerService lit env
-- STRATEGY_MODE (global, redéploiement Fly nécessaire pour toggle).
--
-- Après : `lisa_session_configs.strategy_mode` est la **source de vérité**
-- du badge UI. Trois valeurs explicites :
--
--   - 'investment' : pipeline Lisa LLM classique, profile long_term_investor,
--                    capital_discipline_mode=NONE, stops larges.
--   - 'harvest'    : pipeline Lisa LLM + DAILY_HARVEST, profile hyper_active,
--                    sweep auto vers vault, stops serrés.
--   - 'gainers'    : scanner momentum déterministe 24/7, bypass LLM,
--                    cron 15min cross-asset, paper-broker direct.
--
-- POST /lisa/mode écrit ce champ et applique en cascade les side-effects
-- (profile + capital_discipline_mode pour inv/harvest, autopilot_enabled
-- pour gainers). GET /lisa/mode lit ce champ directement.
--
-- TopGainersScannerService lit `WHERE strategy_mode='gainers' AND autopilot_enabled`
-- en priorité absolue sur env STRATEGY_MODE. Toggle UI = effet immédiat sans
-- redeploy.

-- Étape 1 : ajout de la colonne en NULL pour permettre le backfill.
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS strategy_mode text;

-- Étape 2 : backfill conservatif basé sur la config actuelle.
UPDATE public.lisa_session_configs
SET strategy_mode = CASE
  WHEN profile = 'hyper_active'
       AND capital_discipline_mode = 'DAILY_HARVEST' THEN 'harvest'
  WHEN profile = 'long_term_investor'
       AND (capital_discipline_mode = 'NONE' OR capital_discipline_mode IS NULL) THEN 'investment'
  ELSE 'investment'
END
WHERE strategy_mode IS NULL;

-- Étape 3 : NOT NULL + DEFAULT pour les nouvelles rows.
ALTER TABLE public.lisa_session_configs
  ALTER COLUMN strategy_mode SET DEFAULT 'investment';

ALTER TABLE public.lisa_session_configs
  ALTER COLUMN strategy_mode SET NOT NULL;

-- Étape 4 : check enum strict.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_strategy_mode_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_strategy_mode_check
      CHECK (strategy_mode IN ('investment', 'harvest', 'gainers'));
  END IF;
END $$;

-- Index partiel pour les portfolios en mode gainers (scan SQL fréquent).
CREATE INDEX IF NOT EXISTS lisa_session_configs_gainers_idx
  ON public.lisa_session_configs (portfolio_id)
  WHERE strategy_mode = 'gainers';

COMMENT ON COLUMN public.lisa_session_configs.strategy_mode IS
  'P7 — Mode opératoire UI (badge). investment/harvest = pipeline Lisa LLM (avec presets profile + capital_discipline_mode). gainers = scanner momentum déterministe 24/7 (bypass LLM). Source de vérité du toggle UI.';

-- ─────────────────────────────────────────────────────────────────────────────
-- mode_change_log — audit append-only des transitions de mode
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mode_change_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  old_mode text NOT NULL CHECK (old_mode IN ('investment','harvest','gainers')),
  new_mode text NOT NULL CHECK (new_mode IN ('investment','harvest','gainers')),
  capital_usd numeric(28,2),
  user_agent text,
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mode_change_log_portfolio_idx
  ON public.mode_change_log (portfolio_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS mode_change_log_user_idx
  ON public.mode_change_log (user_id, changed_at DESC);

ALTER TABLE public.mode_change_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'mode_change_log'
      AND policyname = 'mode_change_log_select_owner'
  ) THEN
    CREATE POLICY mode_change_log_select_owner ON public.mode_change_log
      FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

COMMENT ON TABLE public.mode_change_log IS
  'P7 — Audit append-only des bascules de mode opératoire (badge UI investment/harvest/gainers). Inclut le capital au moment du changement et le user-agent pour traçabilité.';
