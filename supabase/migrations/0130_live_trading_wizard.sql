-- 0130_live_trading_wizard
--
-- PR Wizard.1 — Foundations pour l'installer LIVE Trading.
--
-- 2 nouvelles tables :
--   1. live_trading_setup_state : machine d'état du wizard par portfolio
--      (track dans quelle étape l'utilisateur en est)
--   2. live_feature_flags : feature flags DB-backed pour les LIVE-related
--      (override des env vars Fly pour permettre flip via UI au lieu de CLI)
--
-- Sans ces 2 tables, le wizard ne peut pas persister son state ni flipper
-- BROKER_EXECUTION_ENABLED depuis l'UI.

-- ─────────────────────────────────────────────────────────────────────
-- live_trading_setup_state : machine d'état wizard
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_trading_setup_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- État courant du wizard
  current_step INT NOT NULL DEFAULT 1
    CHECK (current_step BETWEEN 1 AND 6),

  -- Status global
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',          -- En cours de configuration
      'sandbox_running',-- Phase de tests sandbox active
      'sandbox_passed', -- Critères Go remplis, prêt pour LIVE
      'sandbox_failed', -- Critères pas remplis, doit ajuster config
      'live_active',    -- LIVE activé
      'live_paused',    -- Kill-switch ou suspension manuelle
      'reverted'        -- Reverted en mode paper après LIVE
    )),

  -- Snapshot des choix utilisateur étape par étape
  step1_brokers JSONB DEFAULT '{}'::jsonb,        -- {ibkr: true, binance: true}
  step2_credentials_status JSONB DEFAULT '{}'::jsonb, -- {ibkr: 'connected', binance: 'pending'}
  step3_mandate_config JSONB DEFAULT '{}'::jsonb, -- guardrail caps + expiresAt
  step4_sandbox_results JSONB DEFAULT '{}'::jsonb,-- {trades, drift, slippage, win_rate}
  step5_activation_at TIMESTAMPTZ,                -- timestamp d'activation LIVE
  step5_activated_by TEXT,                        -- email user

  -- Mandat lié (créé à step 3)
  autonomy_mandate_id UUID REFERENCES public.autonomy_mandates(id) ON DELETE SET NULL,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 1 seul wizard actif par portfolio
  UNIQUE(portfolio_id)
);

CREATE INDEX IF NOT EXISTS live_trading_setup_state_user_idx
  ON public.live_trading_setup_state(user_id);
CREATE INDEX IF NOT EXISTS live_trading_setup_state_status_idx
  ON public.live_trading_setup_state(status);

ALTER TABLE public.live_trading_setup_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'live_trading_setup_state'
      AND policyname = 'live_trading_setup_state_owner'
  ) THEN
    CREATE POLICY live_trading_setup_state_owner ON public.live_trading_setup_state
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

COMMENT ON TABLE public.live_trading_setup_state IS
  'PR Wizard.1 — Machine d''état du wizard LIVE Trading. 1 row par portfolio.';

-- ─────────────────────────────────────────────────────────────────────
-- live_feature_flags : DB-backed flags (override env vars Fly)
-- ─────────────────────────────────────────────────────────────────────
--
-- Permet de flipper les flags LIVE-critiques depuis l'UI au lieu de
-- `flyctl secrets set`. Lecture priorité : DB → env (fallback).
--
-- IMPORTANT : kill-switch garde sa précédence — si AUTONOMY_KILL_SWITCH
-- en env=true, ça override DB=false (sécurité). Convention :
--   - env=true → toujours respecté (override DB) pour kill-switch et
--     les flags de blocage
--   - DB=true → autorise activation (mais pas si env est strict false)

CREATE TABLE IF NOT EXISTS public.live_feature_flags (
  flag_key TEXT PRIMARY KEY
    CHECK (flag_key IN (
      'BROKER_EXECUTION_ENABLED',
      'DELEGATION_AUTONOMOUS_GUARDED',
      'BROKER_RECONCILIATION_ENABLED',
      'BROKER_ADAPTER_IB_ENABLED',
      'BROKER_ADAPTER_BINANCE_ENABLED'
    )),
  enabled BOOLEAN NOT NULL DEFAULT false,
  set_by_user_id UUID REFERENCES auth.users(id),
  set_via TEXT NOT NULL DEFAULT 'env'
    CHECK (set_via IN ('env', 'wizard', 'admin', 'kill_switch_revert')),
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.live_feature_flags ENABLE ROW LEVEL SECURITY;

-- Lecture pour tous les users authentifiés (les flags sont publics/observables)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'live_feature_flags'
      AND policyname = 'live_feature_flags_read_authenticated'
  ) THEN
    CREATE POLICY live_feature_flags_read_authenticated ON public.live_feature_flags
      FOR SELECT USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- Pas de policy INSERT/UPDATE — seul service_role peut modifier
-- (via WizardEndpoint qui valide les conditions de sécurité).

COMMENT ON TABLE public.live_feature_flags IS
  'PR Wizard.1 — DB-backed feature flags pour les LIVE-related. Override env vars Fly via UI wizard. RLS: read-only for authenticated, write via service_role only.';

-- ─────────────────────────────────────────────────────────────────────
-- Audit table : wizard transitions
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.live_wizard_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'wizard_started',
    'step_completed',
    'step_validation_failed',
    'sandbox_started',
    'sandbox_progress',
    'sandbox_passed',
    'sandbox_failed',
    'live_activated',
    'live_paused',
    'live_resumed',
    'kill_switch_activated',
    'wizard_reset'
  )),
  from_step INT,
  to_step INT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_wizard_audit_portfolio_idx
  ON public.live_wizard_audit(portfolio_id, created_at DESC);

ALTER TABLE public.live_wizard_audit ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'live_wizard_audit'
      AND policyname = 'live_wizard_audit_owner_select'
  ) THEN
    CREATE POLICY live_wizard_audit_owner_select ON public.live_wizard_audit
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- Append-only : pas de UPDATE/DELETE, audit immuable.

COMMENT ON TABLE public.live_wizard_audit IS
  'PR Wizard.1 — Audit append-only des transitions wizard. Inclut kill-switch + live_activated pour traçabilité régulatoire.';
