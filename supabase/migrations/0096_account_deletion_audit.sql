-- Migration 0096 — audit table for RGPD account deletion requests
-- user_id is NOT a FK to auth.users (the user will be deleted; we keep the audit row)

create table if not exists public.account_deletion_audit (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null,
  user_email    text,
  requested_at  timestamptz not null default now(),
  completed_at  timestamptz,
  ip_hash       text,          -- sha256(ip) — no raw IP stored
  status        text not null default 'initiated'
                check (status in ('initiated', 'completed', 'failed')),
  error_message text
);

-- Audit is service-role only — no RLS policy = no user access
alter table public.account_deletion_audit enable row level security;

create index if not exists account_deletion_audit_user_id_idx
  on public.account_deletion_audit (user_id);
