-- Migration 0017 — Corpus historique autonome pour l'AI analyst
--
-- PROBLÈME RÉSOLU :
-- La table existante `historical_analogs` (migration 0007) a un FK obligatoire
-- vers `macro_signals` : elle stocke les matchs trouvés POUR UN SIGNAL COURANT
-- donné, pas la base de connaissance historique elle-même.
--
-- Cette migration introduit `historical_events_corpus` : une table autonome,
-- lisible en lecture par tous les utilisateurs authentifiés, maintenue par le
-- service (migrations successives + enrichissement manuel ponctuel). Claude
-- la reçoit en contexte stable à chaque cycle d'analyse (prompt caching
-- Anthropic → -90% de coût tokens sur les runs répétés).
--
-- DESIGN :
-- - slug unique : pour référencer de manière stable ("lehman_2008_collapse")
-- - market_impact_by_asset_class : JSONB structuré avec drawdowns, durées,
--   yields, taux de change — granularité par classe d'actifs et région
-- - preconditions / lessons / limitations : triplet indispensable pour que
--   Claude raisonne proprement (pattern matching + contrefactuel + humilité)
-- - similar_setups_tags : tags pour matching rapide côté AnalogFinderService
-- - data_quality : permet à Claude de pondérer (événements pré-1970 ont
--   souvent des données reconstruites, à prendre avec précaution)

create table if not exists public.historical_events_corpus (
  id uuid primary key default gen_random_uuid(),

  -- Identité stable : utilisé dans les prompts Claude et les audits
  slug text unique not null,
  title text not null,

  -- Classification
  category text not null check (category in (
    'central_bank_decision',
    'inflation_shock',
    'growth_shock',
    'employment_shock',
    'fx_crisis',
    'commodity_shock',
    'geopolitical_conflict',
    'election_event',
    'regulatory_change',
    'market_stress',
    'credit_event',
    'pandemic',
    'systemic_crisis',
    'bubble_burst',
    'currency_crisis',
    'sovereign_crisis',
    'tech_shock',
    'policy_shift'
  )),

  -- Dates : start obligatoire, end nullable si événement ponctuel ou en cours
  date_start date not null,
  date_end date,
  duration_description text,

  -- Contexte narratif
  context_description text not null,

  -- Drivers et préconditions (pour raisonnement analogique)
  -- Exemple key_drivers: ["Subprime CDO collapse", "Investment bank leverage 30x", "Credit default swaps interconnectedness"]
  key_drivers jsonb not null default '[]'::jsonb,
  -- Exemple preconditions: ["House price bubble peaked 2006", "ARM resets accelerating", "Bear Stearns collapse March 2008"]
  preconditions jsonb not null default '[]'::jsonb,

  -- Impact chiffré par classe d'actifs (le cœur de la valeur du corpus)
  -- Clés typiques : equity_us_large, equity_us_small, equity_eu, equity_em,
  --                 govt_bonds_us_10y, credit_ig, credit_hy, commodities_oil,
  --                 commodities_gold, fx_eurusd, crypto_btc, vix
  -- Pour chaque clé :
  -- {
  --   "peak_drawdown_pct": -56.8,            -- pertes cumulées au point bas
  --   "peak_drawdown_date": "2009-03-09",
  --   "duration_to_trough_days": 517,
  --   "duration_to_recovery_days": 1481,     -- temps pour revenir au pic précédent
  --   "yield_move_bps": -340,                -- pour les obligs
  --   "spread_widening_bps": 600,            -- pour le crédit
  --   "notes": "S&P 500 from 1565 to 676"
  -- }
  market_impact_by_asset_class jsonb not null default '{}'::jsonb,

  -- Basculement de régime éventuel (crise 2008 → ZIRP décennale ; covid → inflation)
  regime_shift jsonb,

  -- Comment l'événement s'est résolu (ou pas)
  resolution text,

  -- Leçons tirées + limites de la comparaison (humilité explicite)
  -- Exemple lessons: ["Interconnectedness crée contagion", "Central banks deviennent l'ultime filet"]
  lessons_learned jsonb not null default '[]'::jsonb,
  -- Exemple limitations: ["Régulation post-Dodd-Frank ≠ 2008", "Leverage bancaire divisé par 3", "Pas applicable aux crises souveraines asiatiques"]
  limitations_of_comparison jsonb not null default '[]'::jsonb,

  -- Tags pour matching rapide côté moteur d'analog-finding
  -- ex: ['rate_cycle_peak', 'banking_crisis', 'global_contagion', 'liquidity_crunch']
  similar_setups_tags text[] not null default '{}',

  -- Sévérité au pic (échelle info/watch/warning/critical/systemic)
  severity_at_peak text not null check (severity_at_peak in (
    'info','watch','warning','critical','systemic'
  )),

  -- Qualité des données historiques (Claude pondère en fonction)
  data_quality text not null default 'good' check (data_quality in (
    'excellent',       -- données haute résolution, verified, plusieurs sources
    'good',            -- données solides, sources mainstream
    'partial',         -- données partielles, certaines classes manquent
    'reconstructed'    -- données reconstruites ex-post, marge d'erreur élevée
  )),

  -- Références bibliographiques / sources
  -- ex: [{"type":"paper","title":"This Time Is Different","authors":"Reinhart & Rogoff","year":2009}]
  references jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index pour les requêtes typiques de l'AnalogFinder
create index if not exists historical_events_corpus_category_idx
  on public.historical_events_corpus(category);
create index if not exists historical_events_corpus_severity_idx
  on public.historical_events_corpus(severity_at_peak);
create index if not exists historical_events_corpus_date_start_idx
  on public.historical_events_corpus(date_start desc);
create index if not exists historical_events_corpus_tags_gin
  on public.historical_events_corpus using gin(similar_setups_tags);

-- RLS : lecture publique pour authentifiés (corpus global, non user-scoped),
-- écriture réservée au service role (backend + migrations)
alter table public.historical_events_corpus enable row level security;

create policy "historical_events_corpus_authenticated_read"
  on public.historical_events_corpus for select
  using (auth.role() = 'authenticated');

create policy "historical_events_corpus_service_all"
  on public.historical_events_corpus for all
  to service_role using (true) with check (true);

-- Grants explicites (cohérent avec migrations 0013/0014)
grant select on public.historical_events_corpus to anon, authenticated;
grant all on public.historical_events_corpus to service_role;

-- Trigger updated_at
create or replace function public.touch_historical_events_corpus_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_historical_events_corpus_updated_at on public.historical_events_corpus;
create trigger trg_historical_events_corpus_updated_at
  before update on public.historical_events_corpus
  for each row execute function public.touch_historical_events_corpus_updated_at();
