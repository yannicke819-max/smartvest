-- Ajoute `cost_force_continue` à lisa_session_configs.
--
-- INCIDENT 28/04/2026 05:02 UTC : LlmRouter throw `BudgetExceededError` à
-- $20.46/$20 budget → autopilot bloqué hard, Lisa ne génère plus de thèse.
-- L'UI propose un budget mais ne peut pas configurer le comportement
-- "soft warn vs hard stop" — le default historique est hard stop (PR #15).
--
-- Cette colonne expose le toggle :
--   - `true` (DEFAULT) : à 100% du budget, on bascule sur Haiku 4.5 +
--     warn loggué (cost_budget_warn). Le cycle continue, l'utilisateur
--     reçoit un signal sans rupture de service.
--   - `false` : comportement historique préservé pour les opérateurs qui
--     veulent un hard stop strict (audit, démo, prod réglementée).
--
-- Idempotent : `IF NOT EXISTS` permet replay sans erreur.
-- Cf. fix/cost-soft-budget (PR P0-A 28/04/2026).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'lisa_session_configs'
      AND column_name = 'cost_force_continue'
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD COLUMN cost_force_continue BOOLEAN NOT NULL DEFAULT true;
  END IF;
END $$;

COMMENT ON COLUMN public.lisa_session_configs.cost_force_continue IS
  'P0-A : à 100% du budget Claude API, soft-warn + Haiku fallback (true, default) ou hard throw (false).';
