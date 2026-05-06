-- 0120_lisa_positions_proposal_id_nullable
--
-- Découplage scanner Gainers ↔ pipeline LLM (PR #250).
-- Le scanner Gainers est déterministe — pas besoin d'INSERT lisa_proposals
-- pour ouvrir une position. Avant cette migration : `proposal_id NOT NULL`
-- forçait le scanner à passer par INSERT proposals + approveProposal (LLM
-- pipeline complet) → latence 2-3 sec par open + dépendance structurelle.
--
-- Après : proposal_id nullable, paperBroker.openPositionDirect peut INSERT
-- lisa_positions sans proposal sous-jacent. Le scanner ouvre en ~250 ms.
--
-- Les positions Lisa LLM existantes gardent leur proposal_id (legacy
-- préservé). Seules les nouvelles positions Gainers utilisent proposal_id=NULL.
--
-- Aucun risque : les FKs avec ON DELETE RESTRICT empêchent la suppression
-- d'une proposal liée. Les NULL bypassent la contrainte naturellement.

ALTER TABLE public.lisa_positions
  ALTER COLUMN proposal_id DROP NOT NULL;

ALTER TABLE public.lisa_positions
  ALTER COLUMN thesis_id DROP NOT NULL;

COMMENT ON COLUMN public.lisa_positions.proposal_id IS
  'NULL allowed (PR #250) — scanner Gainers déterministe ouvre sans proposal.';

COMMENT ON COLUMN public.lisa_positions.thesis_id IS
  'NULL allowed (PR #250) — scanner Gainers ouvre sans thèse LLM.';
