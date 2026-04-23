-- 0052_lisa_mechanical_cycle_summary.sql
-- Table de résumé des cycles mécaniques (agent sans LLM).
-- Écrite à la fin de chaque cycle MechanicalTradingService.
-- Lue par computeHistoryMetrics() avant chaque proposal Lisa pour lui
-- transmettre un briefing structuré : ce qui s'est passé depuis sa dernière directive.

create table if not exists public.lisa_mechanical_cycle_summary (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  cycle_at timestamptz not null default now(),

  -- Directive source (nullable si directive expirée entre temps)
  directive_id uuid references public.lisa_mechanical_directives(id) on delete set null,

  -- Activité mécanique depuis la dernière directive Lisa
  opens_count smallint not null default 0,
  closes_stop_count smallint not null default 0,
  closes_target_count smallint not null default 0,
  closes_invalidated_count smallint not null default 0,

  -- P&L mécanique net depuis la directive
  net_pnl_since_proposal_usd numeric(14,4) not null default 0,
  gross_wins_usd numeric(14,4) not null default 0,
  gross_losses_usd numeric(14,4) not null default 0,
  win_rate_pct numeric(5,2) null,
  avg_hold_minutes numeric(8,2) null,

  -- Outliers (meilleur gain / pire perte en %)
  largest_win_pct numeric(8,4) null,
  largest_loss_pct numeric(8,4) null,

  -- Signal de régime : concentration de stops (≥3 en ≤10 min = possible rupture)
  stops_cluster_flag boolean not null default false,
  stops_cluster_window_minutes smallint null,

  -- Santé du portefeuille au moment du cycle
  exposure_pct numeric(5,2) null,          -- % capital déployé
  cash_usd numeric(14,2) null,
  open_positions_count smallint not null default 0,
  drawdown_since_directive_pct numeric(8,4) null,  -- drawdown depuis génération directive

  -- Contexte macro (déjà en cache EODHD, coût $0 supplémentaire)
  vix_level numeric(8,4) null,
  dxy_level numeric(8,4) null,

  -- Fraîcheur de la directive au moment du cycle
  directive_age_minutes smallint null
);

create index if not exists lisa_mechanical_cycle_summary_portfolio_at
  on public.lisa_mechanical_cycle_summary(portfolio_id, cycle_at desc);
