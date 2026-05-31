-- Migration 0177 — Gemini cost kill-switch + manual override
--
-- Suite à dépassement plafond mensuel Google AI Studio 30/05 (414€, service
-- suspendu). Ajout d'un kill-switch automatique sur le coût journalier Gemini
-- avec possibilité d'override manuel par l'utilisateur jusqu'à minuit UTC.
--
-- Architecture :
--   - Daily cost tracker existant : api_costs_daily (table créée migration 0072)
--   - Hard cap : env GEMINI_DAILY_HARD_CAP_USD (default $30)
--   - Manual override : table gemini_cost_override (1 row par date UTC)
--   - GeminiBudgetGuardService.isAllowed() check both
--   - Reset auto à 00:00 UTC quand la date change
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS public.gemini_cost_override (
  date date PRIMARY KEY,
  overridden_at timestamptz NOT NULL DEFAULT NOW(),
  overridden_by_user_id uuid,
  reason text,
  -- Si l'override est utilisé (au moins 1 LLM call après l'override), on flag.
  -- Sert à différencier "override activé mais inutilisé" vs "override appliqué".
  used_at timestamptz
);

COMMENT ON TABLE public.gemini_cost_override IS
'Override manuel du kill-switch Gemini quotidien. 1 row par jour UTC max. L''utilisateur clique "Relancer" depuis l''UI quand le service est bloqué par hard cap. Reset auto à minuit UTC (la PK date change). Cf. migration 0177 + GeminiBudgetGuardService.';

COMMENT ON COLUMN public.gemini_cost_override.date IS
'Date UTC du jour (PK). À minuit UTC, une nouvelle date démarre → ancien override expire automatiquement.';

COMMENT ON COLUMN public.gemini_cost_override.overridden_by_user_id IS
'UUID de l''utilisateur qui a déclenché l''override (audit). NULL si déclenché par admin token ou cron.';

COMMENT ON COLUMN public.gemini_cost_override.reason IS
'Raison libre saisie par l''utilisateur lors du bypass (optionnel). Ex: "Trade A++ détecté", "test debug", etc.';

COMMENT ON COLUMN public.gemini_cost_override.used_at IS
'Timestamp du premier LLM call passé après l''override. NULL si override jamais consommé (hard cap n''a plus été atteint).';

-- RLS — table accessible uniquement via service role (pas exposée en lecture user).
-- Le panel UI lit via endpoint API qui passe par la service key.
ALTER TABLE public.gemini_cost_override ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gemini_cost_override_service_only" ON public.gemini_cost_override;
CREATE POLICY "gemini_cost_override_service_only" ON public.gemini_cost_override
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
