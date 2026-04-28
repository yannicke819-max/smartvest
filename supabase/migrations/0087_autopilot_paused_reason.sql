-- P8-BR — AUTOPILOT BUDGET RESILIENCE
--
-- Découple kill-switch (manuel/critique) du budget-pause (réversible).
-- Avant : `autopilot_enabled` flippait à false sur BudgetExceededError →
--         autopilot OFF silencieusement, intervention manuelle requise pour
--         reprendre. Constat live 27-28/04 : 6h sans cycle, 0 trade.
--
-- Après : nouvelle colonne `autopilot_paused_reason TEXT NULL`. Quand le
--         budget est dépassé, on positionne `paused_reason='BUDGET_EXCEEDED'`
--         sans toucher `autopilot_enabled`. Au cycle suivant, si le coût
--         journalier est redescendu sous 90% du budget (rollover UTC ou
--         budget bumped), on CLEAR paused_reason et on reprend.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS autopilot_paused_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_autopilot_paused_reason_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_autopilot_paused_reason_check
      CHECK (
        autopilot_paused_reason IS NULL
        OR autopilot_paused_reason IN ('BUDGET_EXCEEDED', 'MANUAL', 'PROVIDER_OUTAGE')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lisa_session_configs_paused_idx
  ON public.lisa_session_configs (autopilot_paused_reason)
  WHERE autopilot_paused_reason IS NOT NULL;

COMMENT ON COLUMN public.lisa_session_configs.autopilot_paused_reason IS
  'P8-BR — Pause réversible de l''autopilot, distincte du kill-switch (manuel/critique). Set à BUDGET_EXCEEDED par lisa.service quand le budget journalier est atteint, cleared automatiquement par lisa-autopilot quand le coût retombe sous 90% du budget (rollover UTC ou budget bumped). MANUAL et PROVIDER_OUTAGE réservés pour usages futurs (admin pause + outage detection).';
