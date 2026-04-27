-- 0072_api_costs_daily.sql
--
-- PATCH 4 (PR#4 P1) — running total des coûts API journaliers.
--
-- Permet le hard-stop budget côté lisa.service.generateProposal :
-- avant d'appeler Claude (~$0.17 Opus), on lit le total today vs le
-- daily_cost_budget_usd configuré. Si dépassé → autopilot disabled +
-- BudgetExceededError thrown.
--
-- Source de vérité primaire : lisa_proposals.claude_cost_usd. Cette table
-- agrège pour permettre une lecture O(1) (pas de SUM full table par cycle).
-- Breakdown by_model JSONB anticipe PATCH 7 (LLM router Opus/Sonnet/Haiku).

CREATE TABLE IF NOT EXISTS public.api_costs_daily (
  date DATE PRIMARY KEY,
  total_usd NUMERIC(10,4) NOT NULL DEFAULT 0,
  by_model JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.api_costs_daily IS
  'Running total des coûts API LLM par jour. Utilisé pour le hard-stop budget. Cf. PATCH 4 risk-04-adaptive-safetynet-budget.';

COMMENT ON COLUMN public.api_costs_daily.by_model IS
  'Breakdown {model_name: cost_usd}. Anticipe PATCH 7 LLM router.';

-- Index sur updated_at pour audits éventuels
CREATE INDEX IF NOT EXISTS api_costs_daily_updated_at_idx
  ON public.api_costs_daily (updated_at DESC);
