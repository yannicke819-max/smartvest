-- 0051_lisa_mechanical_directives.sql
-- Table des directives que Lisa écrit toutes les 30 min.
-- L'agent mécanique (cron 1 min) les lit pour ouvrir/fermer des positions
-- sans appel Claude → coût $0 par cycle mécanique.
--
-- Changement sur lisa_positions :
--   proposal_id devient nullable + colonne source ajoutée.
--   Les positions ouvertes par l'agent mécanique n'ont pas de proposal Claude.

-- ─── Table directives ────────────────────────────────────────────────────────

create table if not exists public.lisa_mechanical_directives (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,

  -- Contexte de marché transmis par Lisa
  market_momentum text not null default 'neutral'
    check (market_momentum in ('bullish_strong', 'neutral', 'bearish')),

  -- Thèmes actifs identifiés par Lisa (ex: ["BTC/ETH breakout", "DXY divergence"])
  active_themes jsonb not null default '[]',

  -- Classes d'actifs favorisées / évitées
  favored_asset_classes jsonb not null default '[]',
  avoided_asset_classes jsonb not null default '[]',

  -- Symboles cibles avec paramètres d'exécution
  -- [{symbol, assetClass, direction, stopLossPct, takeProfitPct, convictionScore,
  --   horizonDays, thesisId (nullable), venue}]
  target_symbols jsonb not null default '[]',

  -- Positions à fermer selon Lisa
  -- [{positionId, reason, urgency: 'immediate'|'at_stop'|'on_next_unfavorable_price'}]
  close_conditions jsonb not null default '[]',

  -- Posture de risque globale
  risk_posture text not null default 'normal'
    check (risk_posture in ('aggressive', 'normal', 'defensive')),

  -- Proposal Claude source (référence, peut être null si directive synthétique)
  source_proposal_id uuid references public.lisa_proposals(id) on delete set null,

  generated_at timestamptz not null default now(),

  -- Validité : l'agent mécanique ignore les directives expirées
  valid_until timestamptz not null
);

create index if not exists lisa_mechanical_directives_portfolio_valid
  on public.lisa_mechanical_directives(portfolio_id, valid_until desc);

-- ─── Alter lisa_positions : proposal_id nullable + colonne source ─────────────

do $$ begin
  -- Rendre proposal_id nullable (positions mécaniques n'ont pas de proposal Claude)
  alter table public.lisa_positions
    alter column proposal_id drop not null;
exception when others then null; end $$;

do $$ begin
  alter table public.lisa_positions
    add column source text not null default 'lisa'
      check (source in ('lisa', 'mechanical'));
exception when duplicate_column then null; end $$;
