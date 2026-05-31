-- Migration 0180 — Extension A/B shadow 4-way avec Mistral Large 3
--
-- Contexte : suite à PR #519 (Mistral Medium 3.5 shadow ajouté) et PR #520
-- (correction default Medium au lieu de Large), on souhaite tester aussi
-- Mistral Large 3 (cheap tier Mistral) en parallèle pour comparer 4 providers
-- simultanément :
--   - Pro    (Gemini 2.5 Pro)       : décision RÉELLEMENT APPLIQUÉE
--   - Flash  (Gemini 2.5 Flash)     : shadow Gemini cheap tier (PR #508)
--   - Mistral Medium 3.5            : shadow Mistral équivalent qualité Pro (PR #519/#520)
--   - Mistral Large 3 (NOUVEAU)     : shadow Mistral cheap tier (cette migration)
--
-- Pourquoi tester Large 3 aussi alors qu'il est moins capable que Medium :
-- Comparer 2 cheap tiers (Flash Google vs Large 3 Mistral) sur même décisions.
-- Si Large 3 ≥ Flash en concordance avec Pro, alors Mistral domine le cheap
-- tier aussi. Si Large 3 < Flash, Google reste meilleur sur ce tier.
--
-- Décision vendredi prochain basée sur :
--   SELECT
--     AVG(concordance_full)*100 AS pro_eq_flash,
--     AVG(concordance_pro_vs_mistral_full)*100 AS pro_eq_medium,
--     AVG(concordance_pro_vs_mistral_large_full)*100 AS pro_eq_large,
--     SUM(pro_cost_usd) AS cost_pro,
--     SUM(flash_cost_usd) AS cost_flash,
--     SUM(mistral_cost_usd) AS cost_medium,
--     SUM(mistral_large_cost_usd) AS cost_large
--   FROM gemini_ab_decisions
--   WHERE decided_at > NOW() - INTERVAL '7 days';
--
-- Idempotente.

ALTER TABLE public.gemini_ab_decisions
  ADD COLUMN IF NOT EXISTS mistral_large_action_kind text,
  ADD COLUMN IF NOT EXISTS mistral_large_target_symbol text,
  ADD COLUMN IF NOT EXISTS mistral_large_direction text,
  ADD COLUMN IF NOT EXISTS mistral_large_confidence numeric(3, 2),
  ADD COLUMN IF NOT EXISTS mistral_large_notional_usd numeric(12, 2),
  ADD COLUMN IF NOT EXISTS mistral_large_thesis text,
  ADD COLUMN IF NOT EXISTS mistral_large_cost_usd numeric(10, 6),
  ADD COLUMN IF NOT EXISTS mistral_large_latency_ms int,
  ADD COLUMN IF NOT EXISTS mistral_large_provider text,
  ADD COLUMN IF NOT EXISTS mistral_large_call_error text,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_large_action boolean,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_large_target boolean,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_large_full boolean;

COMMENT ON COLUMN public.gemini_ab_decisions.mistral_large_action_kind IS
'Mistral Large 3 shadow decision (jamais appliquee). 4-way comparison Pro/Flash/Medium 3.5/Large 3. Activation : MISTRAL_API_KEY + MISTRAL_LARGE_SHADOW_ENABLED=true.';

COMMENT ON COLUMN public.gemini_ab_decisions.concordance_pro_vs_mistral_large_full IS
'True si Mistral Large 3 et Pro sortent EXACTEMENT la meme action_kind ET target_symbol. NULL si Large parse failed ou service disabled. Objectif vs Flash : si pct_pro_eq_large > pct_pro_eq_flash sur 7j, Mistral domine cheap tier.';
