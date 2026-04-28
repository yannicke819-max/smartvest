-- P4-B — Schema routing sources de propositions par mode opératoire.
--
-- ⚠️ Schema-only. Le routing runtime est en pure helper TS
-- (`packages/ai-analyst/src/strategies/proposal-source-routing.ts`,
-- `getProposalSources(mode)`) et fonctionne SANS cette migration.
--
-- Cette migration ajoute des colonnes per-portfolio pour permettre
-- l'override admin/UI (futur). Tant que ces colonnes sont NULL, le
-- helper TS retourne ses defaults hardcodés ; quand renseignées, le
-- caller (LisaService.generateProposal) pourra les lire en priorité
-- (follow-up wiring).
--
-- Justification spec ticket P4-B : "INSERT lisa_session_configs
-- (key='harvest_proposal_sources', value=...)". lisa_session_configs
-- n'est pas key-value → on stocke comme colonnes text[] structurées.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS).

-- Sources actives en mode DAILY_HARVEST. NULL = défaut helper TS
-- (rebound_tp_scanner + mechanical_stops).
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS harvest_proposal_sources text[];

-- Sources actives en mode INVESTMENT/NONE. NULL = défaut helper TS
-- (5 sources : rebound + momentum + narrative_stocktwits + sentiment_macro + mechanical_stops).
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS investment_proposal_sources text[];

COMMENT ON COLUMN public.lisa_session_configs.harvest_proposal_sources IS
  'P4-B — Override des sources de propositions actives en mode DAILY_HARVEST. NULL = défaut TS helper getProposalSources(harvest) = [rebound_tp_scanner, mechanical_stops].';

COMMENT ON COLUMN public.lisa_session_configs.investment_proposal_sources IS
  'P4-B — Override des sources actives en mode INVESTMENT/NONE. NULL = défaut TS helper [rebound_tp_scanner, momentum_breakout, narrative_stocktwits, sentiment_macro, mechanical_stops].';
