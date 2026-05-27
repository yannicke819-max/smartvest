-- Migration 0170 — scanner_lessons : apprentissage Gemini pour le scanner gainers
--
-- Le scanner gainers est volontairement déterministe (cf. ADR P19, PR #250).
-- Cette table accueille les lessons générées par MainScannerPostMortemService
-- (cron 02:30 UTC) qui analyse chaque jour les positions closed des 4 portfolios
-- (MAIN + HIGH + MIDDLE + SMALL) et génère des règles macro-conditionnelles
-- réinjectées dans les system prompts de GeminiRiskManager + MacroVeto + scanner.
--
-- Critère de qualité : chaque lesson DOIT avoir une macro_condition + sample_size
-- ≥ 5 trades pour être actionnable (sinon noise statistique).

CREATE TABLE IF NOT EXISTS public.scanner_lessons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  derived_from_date DATE NOT NULL,
  -- Categorie : losing_pattern | winning_pattern | gate_calibration |
  -- risk_observation | sizing_rule | exit_rule | session_filter
  lesson_kind TEXT NOT NULL,
  -- Texte actionable : "Quand <CONDITION>, alors <ACTION>"
  lesson_text TEXT NOT NULL,
  -- Condition macro éligible (enum souple)
  -- ex: VIX>25, US10Y>4.5, REGIME_CALME, ASIA_LATE_SESSION, EU_OPEN_FIRST_HOUR
  macro_condition TEXT,
  -- Scope d'application
  -- ex: all_scanner, main_only, shadows_only, asia_only, eu_only, us_only, crypto_only
  scope TEXT NOT NULL DEFAULT 'all_scanner',
  -- Confidence Gemini (0.0-1.0)
  confidence NUMERIC(3, 2) DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  -- Si Gemini propose un changement de config concret (env var ou DB column)
  -- ex: { "GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED": "false" }
  -- ex: { "lisa_session_configs.gainers_default_tp_pct": 2.0 }
  proposed_config_change JSONB,
  -- Si la proposition a été appliquée (par humain ou auto si confidence ≥ 0.95)
  applied BOOLEAN NOT NULL DEFAULT false,
  applied_at TIMESTAMPTZ,
  applied_by TEXT,  -- 'auto' | 'human:<email>'
  -- Stats source pour audit
  sample_size INT,
  win_rate_observed NUMERIC(5, 2),
  avg_pnl_usd NUMERIC(10, 2),
  -- Réinjecté dans les prompts si is_active. Désactivable manuellement.
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- Payload raw : breakdown trades, indicators, regime context
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_scanner_lessons_active
  ON public.scanner_lessons(is_active, derived_from_date DESC)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_scanner_lessons_macro
  ON public.scanner_lessons(macro_condition)
  WHERE macro_condition IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scanner_lessons_scope
  ON public.scanner_lessons(scope);

COMMENT ON TABLE public.scanner_lessons IS
  'Lessons générées par MainScannerPostMortemService (cron 02:30 UTC daily). Réinjectées dans system prompts GeminiRiskManager + MacroVeto + scanner LLM validation.';

-- Reload PostgREST schema cache (sinon API ne voit pas la table immédiatement)
NOTIFY pgrst, 'reload schema';
