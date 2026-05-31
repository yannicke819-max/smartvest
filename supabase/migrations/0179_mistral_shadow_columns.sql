-- Migration 0179 — Extension A/B shadow avec Mistral Large 3
--
-- Contexte : suite à analyse cost comparison Mistral vs Gemini vs Anthropic
-- (31/05/2026), Mistral Large 3 ressort à $0.5/$1.5 per MTok = 74% moins cher
-- que Gemini 2.5 Pro pour qualité benchmarks équivalente. On souhaite valider
-- empiriquement la concordance des décisions Pro vs Flash vs Mistral sur 7-14
-- jours avant toute migration TRADER.
--
-- Le 3-way shadow réutilise la table existante `gemini_ab_decisions` (créée
-- migration 0178). Ajout de colonnes mistral_* pour Mistral decision + 3
-- colonnes concordance Pro vs Mistral.
--
-- ADR-001 reste valide : Mistral N'EST PAS dans le router principal. Le call
-- vit dans MistralShadowService (apps/api), pas dans ai-analyst/llm/providers.
-- Réintroduction conditionnelle (amender ADR-001 → ADR-007) UNIQUEMENT si
-- shadow data montre concordance ≥ 85% sur 14j + différentiel coût significatif.
--
-- Idempotente.

ALTER TABLE public.gemini_ab_decisions
  ADD COLUMN IF NOT EXISTS mistral_action_kind text,
  ADD COLUMN IF NOT EXISTS mistral_target_symbol text,
  ADD COLUMN IF NOT EXISTS mistral_direction text,
  ADD COLUMN IF NOT EXISTS mistral_confidence numeric(3, 2),
  ADD COLUMN IF NOT EXISTS mistral_notional_usd numeric(12, 2),
  ADD COLUMN IF NOT EXISTS mistral_thesis text,
  ADD COLUMN IF NOT EXISTS mistral_cost_usd numeric(10, 6),
  ADD COLUMN IF NOT EXISTS mistral_latency_ms int,
  ADD COLUMN IF NOT EXISTS mistral_provider text,
  ADD COLUMN IF NOT EXISTS mistral_call_error text,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_action boolean,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_target boolean,
  ADD COLUMN IF NOT EXISTS concordance_pro_vs_mistral_full boolean;

COMMENT ON COLUMN public.gemini_ab_decisions.mistral_action_kind IS
'Mistral Large 3 decision (jamais appliquee — shadow uniquement). Permet 3-way comparison Pro vs Flash vs Mistral. Activation : MISTRAL_API_KEY + MISTRAL_SHADOW_ENABLED=true.';

COMMENT ON COLUMN public.gemini_ab_decisions.concordance_pro_vs_mistral_full IS
'True si Mistral et Pro sortent EXACTEMENT la meme action_kind ET target_symbol. NULL si Mistral parse failed ou disabled. Objectif analyse : si >= 85% concordance sur 14j, migration TRADER Pro -> Mistral economiserait ~74% du cout LLM.';
