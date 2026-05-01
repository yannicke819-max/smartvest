-- S5 : table de suivi de l'onboarding grand-public (4 étapes).
-- Séparée de user_profiles pour ne pas modifier le schéma existant.
create table if not exists public.user_onboarding (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  completed_at   timestamptz,
  skipped_at     timestamptz,
  level          text check (level in ('none','basic','moderate','advanced','expert')),
  risk_tolerance text check (risk_tolerance in ('very_low','low','medium','high','very_high')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.user_onboarding enable row level security;

create policy "user_onboarding_own_row"
  on public.user_onboarding for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
