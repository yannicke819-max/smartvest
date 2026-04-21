-- Migration 0014 — durcissement sécurité suite aux warnings du linter Supabase
--
-- Issues traitées :
--  1. `mark_onboarding_completed` : search_path non fixé (role-mutable)
--  2. Vues `latest_quotes` / `latest_bars` avec SECURITY DEFINER implicite
--  3. Tables publiques sans RLS : `markets`, `fx_rates`, `assets`, `brokers`
--  4. Policies `using (true)` / `with check (true)` trop permissives sur les
--     tables du module macro — on les restreint au rôle `service_role`.
--
-- Aucune rupture de compatibilité : le backend NestJS utilise la clé service
-- role (elle bypasse la RLS de toute façon) et les tables publiques passent
-- en lecture seule pour anon/authenticated.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Fonction mark_onboarding_completed : fixer search_path
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.mark_onboarding_completed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.user_profiles
  set onboarding_completed = true, updated_at = now()
  where id = new.user_id;
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Vues SECURITY DEFINER → security_invoker (Postgres 15+)
-- ─────────────────────────────────────────────────────────────────────────────
-- `security_invoker = true` fait en sorte que la vue applique les permissions
-- RLS de l'utilisateur qui interroge, pas de celui qui l'a créée.
alter view if exists public.latest_quotes set (security_invoker = true);
alter view if exists public.latest_bars set (security_invoker = true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Activer RLS sur les tables publiques de référence (market data)
-- ─────────────────────────────────────────────────────────────────────────────
-- Ces tables sont globales (référentiel marché) — lecture libre, écriture
-- exclusivement via service role.

alter table if exists public.markets enable row level security;
drop policy if exists "markets_public_read" on public.markets;
create policy "markets_public_read" on public.markets
  for select using (true);

alter table if exists public.fx_rates enable row level security;
drop policy if exists "fx_rates_public_read" on public.fx_rates;
create policy "fx_rates_public_read" on public.fx_rates
  for select using (true);

alter table if exists public.assets enable row level security;
drop policy if exists "assets_public_read" on public.assets;
create policy "assets_public_read" on public.assets
  for select using (true);

alter table if exists public.brokers enable row level security;
drop policy if exists "brokers_public_read" on public.brokers;
create policy "brokers_public_read" on public.brokers
  for select using (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Restreindre les policies « service write » trop larges
-- ─────────────────────────────────────────────────────────────────────────────
-- La clé service role bypasse la RLS nativement, donc restreindre à
-- `service_role` ne change rien pour le backend — mais supprime le warning
-- du linter qui voit une policy `using (true)` comme un bypass effectif.

drop policy if exists "macro_signals: service write" on public.macro_signals;
drop policy if exists "macro_signals: service update" on public.macro_signals;
create policy "macro_signals_service_write"
  on public.macro_signals for insert
  to service_role with check (true);
create policy "macro_signals_service_update"
  on public.macro_signals for update
  to service_role using (true) with check (true);

drop policy if exists "signal_impact_assessments: service write" on public.signal_impact_assessments;
create policy "signal_impact_assessments_service_all"
  on public.signal_impact_assessments for all
  to service_role using (true) with check (true);

drop policy if exists "historical_analogs: service write" on public.historical_analogs;
create policy "historical_analogs_service_all"
  on public.historical_analogs for all
  to service_role using (true) with check (true);

drop policy if exists "retex_insights: service write" on public.retex_insights;
create policy "retex_insights_service_all"
  on public.retex_insights for all
  to service_role using (true) with check (true);

drop policy if exists "signal_conclusions: service write" on public.signal_conclusions;
create policy "signal_conclusions_service_all"
  on public.signal_conclusions for all
  to service_role using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. S'assurer que les GRANTs sont en place (filet de sécurité si 0013 n'a
--    pas été rejouée sur Railway par le worker de migrations).
-- ─────────────────────────────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
-- Filet de sécurité : service_role devrait avoir BYPASSRLS + full grants par
-- défaut dans Supabase, mais si un REVOKE historique a cassé ça, on réaffirme.
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to authenticated, service_role;
