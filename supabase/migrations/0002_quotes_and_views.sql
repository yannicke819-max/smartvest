-- Migration 0002 — table quotes + vue latest_quotes + extension onboarding_flag

-- Table des cotations (snapshot manuel ou importé).
-- Pas de cours temps réel encore — alimentée par les seeds ou imports manuels.
create table if not exists public.quotes (
  asset_id uuid not null references public.assets(id) on delete cascade,
  price numeric(28, 10) not null,
  currency char(3) not null,
  as_of timestamptz not null,
  source text not null default 'manual',
  primary key (asset_id, as_of)
);
create index if not exists quotes_asset_id_idx on public.quotes(asset_id);

alter table public.quotes enable row level security;
create policy "quotes_readable_by_authenticated"
  on public.quotes for select
  using (auth.role() = 'authenticated');

-- Vue dédupliquée : prix le plus récent par actif.
create or replace view public.latest_quotes as
select distinct on (asset_id) asset_id, price, currency, as_of, source
from public.quotes
order by asset_id, as_of desc;

-- Colonne onboarding_completed sur user_profiles pour orienter la navigation.
alter table public.user_profiles
  add column if not exists onboarding_completed boolean not null default false;

-- Mettre à jour onboarding_completed quand un portefeuille est créé.
create or replace function public.mark_onboarding_completed()
returns trigger language plpgsql security definer as $$
begin
  update public.user_profiles
  set onboarding_completed = true, updated_at = now()
  where id = new.user_id;
  return new;
end;
$$;

drop trigger if exists on_portfolio_created on public.portfolios;
create trigger on_portfolio_created
  after insert on public.portfolios
  for each row execute function public.mark_onboarding_completed();
