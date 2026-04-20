-- 0008_action_proposals_dedup.sql
-- Adds dedup metadata columns to action_proposals to support the automatic
-- proposal generator (Chantier 4 — Phase 5). Existing proposals keep NULL values;
-- new ones are tagged by their source (drift, concentration, goal_trigger,
-- macro_signal, drawdown, benchmark) and a deterministic dedup_key that the
-- generator uses to suppress near-duplicates across runs.
--
-- RLS policy is unchanged (action_proposals_owner on user_id).

alter table public.action_proposals
  add column if not exists dedup_key text;

alter table public.action_proposals
  add column if not exists source_kind text;

-- Composite index optimises the dedup lookup performed by
-- ProposalGeneratorService.isDuplicate(): portfolio_id + source_kind
-- + dedup_key, filtered by created_at within the per-source window.
create index if not exists idx_action_proposals_dedup
  on public.action_proposals(portfolio_id, source_kind, dedup_key, created_at);
