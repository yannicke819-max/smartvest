-- 0128_broker_orders_and_reconciliation
--
-- Phase A — IBKR LIVE Trading (cf. PRD docs/PRD-IBKR-LIVE-TRADING.md).
--
-- Ajoute 2 tables pour le tracking des ordres réels live + reconciliation
-- broker vs DB. Aucune impact runtime tant que BROKER_EXECUTION_ENABLED=false :
-- les tables sont vides en mode paper, alimentées uniquement quand un adapter
-- live (IBKR/Binance) commence à placer de vrais ordres.
--
-- 1. broker_orders : tracking append-only des ordres broker
--    - 1 ligne par tentative placeOrder (même rejected)
--    - liée au lisa_position quand fill confirmé
--    - tracking commission réelle + slippage observé
--
-- 2. broker_reconciliation_log : audit hash-chaîné des comparaisons
--    périodiques entre positions DB (lisa_positions) et positions broker.
--    Détection drift → kill-switch automatique.

-- ─────────────────────────────────────────────────────────────────────
-- broker_orders : tracking ordres réels broker (append-only)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.broker_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  broker_connection_id UUID NOT NULL REFERENCES public.broker_connections(id) ON DELETE RESTRICT,

  -- Lien vers la position SmartVest (NULL avant fill confirmé)
  lisa_position_id UUID REFERENCES public.lisa_positions(id) ON DELETE SET NULL,

  -- Identifiant côté broker (NULL avant ack)
  external_order_id TEXT,

  -- Order data
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
  quantity NUMERIC(28,10) NOT NULL,
  limit_price NUMERIC(28,10),

  -- Tracking lifecycle
  status TEXT NOT NULL CHECK (status IN (
    'submitted',     -- Envoyé au broker, ack pending
    'accepted',      -- Broker a accepté, en attente de fill
    'partial_fill',  -- Fill partiel
    'filled',        -- Complètement rempli
    'rejected',      -- Refusé par le broker
    'canceled',      -- Annulé manuellement ou auto
    'expired'        -- Time-in-force expirée sans fill
  )),
  reject_reason TEXT,

  -- Fill details (renseignés au fur et à mesure)
  filled_quantity NUMERIC(28,10) NOT NULL DEFAULT 0,
  avg_fill_price NUMERIC(28,10),
  commission_usd NUMERIC(28,4),
  slippage_bps INT,  -- (avg_fill_price - expected_price) / expected_price × 10000

  -- Timestamps
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  first_fill_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,

  -- Audit
  raw_response JSONB,  -- snapshot de la réponse broker (debug)
  triggered_by TEXT,   -- 'autopilot_cron' / 'force_close' / 'kill_switch' / 'manual'

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS broker_orders_portfolio_idx
  ON public.broker_orders(portfolio_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS broker_orders_external_id_idx
  ON public.broker_orders(external_order_id) WHERE external_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broker_orders_lisa_position_idx
  ON public.broker_orders(lisa_position_id) WHERE lisa_position_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broker_orders_status_idx
  ON public.broker_orders(portfolio_id, status, submitted_at DESC);

ALTER TABLE public.broker_orders ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'broker_orders'
      AND policyname = 'broker_orders_owner_select'
  ) THEN
    CREATE POLICY broker_orders_owner_select ON public.broker_orders
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'broker_orders'
      AND policyname = 'broker_orders_owner_modify'
  ) THEN
    CREATE POLICY broker_orders_owner_modify ON public.broker_orders
      FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

COMMENT ON TABLE public.broker_orders IS
  'Phase A LIVE — Append-only tracking des ordres réels broker. 1 ligne par tentative placeOrder. Vide tant que BROKER_EXECUTION_ENABLED=false.';

-- ─────────────────────────────────────────────────────────────────────
-- broker_reconciliation_log : audit comparaisons broker vs DB
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.broker_reconciliation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  broker_connection_id UUID NOT NULL REFERENCES public.broker_connections(id) ON DELETE RESTRICT,

  -- Reconciliation outcome
  status TEXT NOT NULL CHECK (status IN (
    'ok',                    -- DB et broker alignés
    'broker_extra',          -- Position broker non trackée en DB → INSERT
    'db_extra',              -- Position DB non trouvée broker → ALERT + kill-switch
    'mismatch',              -- Quantity/price mismatch
    'broker_unreachable',    -- Broker timeout (grace period)
    'kill_switch_triggered'  -- Drift critique → kill-switch fired
  )),

  -- Snapshot des positions au moment du check
  db_positions_count INT NOT NULL DEFAULT 0,
  broker_positions_count INT NOT NULL DEFAULT 0,
  drifted_positions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Metrics
  total_value_usd_db NUMERIC(28,4),
  total_value_usd_broker NUMERIC(28,4),
  drift_value_usd NUMERIC(28,4),

  -- Hash chain (cf. ExecutionAudit pattern)
  prev_hash TEXT,
  this_hash TEXT NOT NULL,

  details JSONB NOT NULL DEFAULT '{}'::jsonb,

  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS broker_reconciliation_log_portfolio_idx
  ON public.broker_reconciliation_log(portfolio_id, ran_at DESC);
CREATE INDEX IF NOT EXISTS broker_reconciliation_log_status_idx
  ON public.broker_reconciliation_log(status, ran_at DESC)
  WHERE status != 'ok';

ALTER TABLE public.broker_reconciliation_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'broker_reconciliation_log'
      AND policyname = 'broker_reconciliation_log_owner_select'
  ) THEN
    CREATE POLICY broker_reconciliation_log_owner_select ON public.broker_reconciliation_log
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

-- Append-only : pas de UPDATE/DELETE policies (seul l'INSERT est permis via service role).

COMMENT ON TABLE public.broker_reconciliation_log IS
  'Phase A LIVE — Append-only hash-chaîné des comparaisons positions DB vs broker (cron 5min). Drift critique → kill-switch automatique.';
