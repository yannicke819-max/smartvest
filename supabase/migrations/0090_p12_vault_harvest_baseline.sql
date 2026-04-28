-- 0090 — P12 BASELINE : vault_balances, vault_movements, harvest_sessions, harvest_sweeps
--
-- Ces tables existent en prod Supabase mais aucune migration ne les documente.
-- Ce fichier est un rattrapage de schéma (baseline), uniquement CREATE TABLE IF
-- NOT EXISTS — idempotent, aucune modification de données, aucun ALTER sur les
-- tables existantes.
--
-- Concepts :
--   harvest_sessions   — sessions journalières de trading (alias/extension
--                        de daily_trading_sessions). 1 ligne par (portfolio, jour).
--   vault_balances     — solde cumulatif du vault sécurisé par portfolio
--                        (vue consolidée, complémentaire à secured_profit_balance).
--   vault_movements    — registre append-only de chaque entrée/sortie de vault
--                        (traçabilité individuelle des sweeps).
--   harvest_sweeps     — détail de chaque sweep PER_TRADE ou END_OF_DAY
--                        déclenché par ProfitSweepService.
--
-- Toutes les tables sont scoped par portfolio_id (FK → portfolios).
-- RLS activé sur chaque table : SELECT uniquement pour le propriétaire.
-- INSERT/UPDATE/DELETE réservés au service role.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. harvest_sessions
--    Journaux de sessions de trading intraday (mode DAILY_HARVEST).
--    Schéma aligné sur daily_trading_sessions (migration 0066).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.harvest_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  session_date      date        NOT NULL,
  session_timezone  text        NOT NULL DEFAULT 'Europe/Paris',
  started_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,

  working_capital_start_usd  numeric(28, 2) NOT NULL,
  daily_target_amount_usd    numeric(28, 2),
  daily_target_percent       numeric(8, 4),
  max_loss_per_day_usd       numeric(28, 2),
  max_trades_per_day         integer,

  state text NOT NULL DEFAULT 'IDLE'
    CHECK (state IN (
      'IDLE', 'ACTIVE', 'TARGET_NEAR', 'TARGET_HIT',
      'PROFIT_SWEEP_PENDING', 'PROFIT_SWEPT',
      'DAILY_LOCKED', 'LOSS_LIMIT_HIT', 'SESSION_CLOSED'
    )),

  realized_pnl_usd   numeric(28, 2) NOT NULL DEFAULT 0,
  secured_pnl_usd    numeric(28, 2) NOT NULL DEFAULT 0,
  unrealized_pnl_usd numeric(28, 2),

  trades_count         integer NOT NULL DEFAULT 0,
  winning_trades_count integer NOT NULL DEFAULT 0,
  losing_trades_count  integer NOT NULL DEFAULT 0,

  last_transition_at     timestamptz NOT NULL DEFAULT now(),
  last_transition_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT harvest_sessions_unique_per_day
    UNIQUE (portfolio_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_harvest_sessions_portfolio_date
  ON public.harvest_sessions (portfolio_id, session_date DESC);

CREATE INDEX IF NOT EXISTS idx_harvest_sessions_state
  ON public.harvest_sessions (portfolio_id, state)
  WHERE state NOT IN ('SESSION_CLOSED');

ALTER TABLE public.harvest_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'harvest_sessions' AND policyname = 'harvest_sessions_owner_select'
  ) THEN
    CREATE POLICY harvest_sessions_owner_select
      ON public.harvest_sessions FOR SELECT
      USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.harvest_sessions IS
  'P12-BASELINE — Sessions journalières intraday (mode DAILY_HARVEST). '
  'Existe en prod depuis P4-A / daily-harvest feature. '
  'Schéma aligné sur daily_trading_sessions (0066) avec nommage court.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. vault_balances
--    Solde consolidé du vault sécurisé par portfolio.
--    Complémentaire à secured_profit_balance (0067) — vue opérationnelle.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vault_balances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL UNIQUE REFERENCES public.portfolios(id) ON DELETE CASCADE,

  total_deposited_usd  numeric(28, 2) NOT NULL DEFAULT 0,
  total_withdrawn_usd  numeric(28, 2) NOT NULL DEFAULT 0,
  current_balance_usd  numeric(28, 2) NOT NULL DEFAULT 0,

  deposit_count    integer NOT NULL DEFAULT 0,
  withdrawal_count integer NOT NULL DEFAULT 0,

  first_deposit_at  timestamptz,
  last_deposit_at   timestamptz,
  last_movement_at  timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_balances_portfolio
  ON public.vault_balances (portfolio_id);

ALTER TABLE public.vault_balances ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'vault_balances' AND policyname = 'vault_balances_owner_select'
  ) THEN
    CREATE POLICY vault_balances_owner_select
      ON public.vault_balances FOR SELECT
      USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.vault_balances IS
  'P12-BASELINE — Solde consolidé du vault sécurisé (profits sweepés hors capital de trading). '
  'Lecture seule pour le runtime Lisa. INSERT/UPDATE réservé au service role.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. vault_movements
--    Registre append-only de chaque entrée/sortie dans le vault.
--    Immuable après INSERT (pas d'UPDATE ni DELETE en prod).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vault_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- 'deposit' : profit sweepé → vault  /  'withdrawal' : retrait admin explicite
  kind         text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount_usd   numeric(28, 2) NOT NULL CHECK (amount_usd > 0),

  -- Lien optionnel vers la position source (PER_TRADE sweep)
  source_position_id uuid REFERENCES public.lisa_positions(id) ON DELETE SET NULL,
  -- Lien optionnel vers la session source
  source_session_id  uuid REFERENCES public.harvest_sessions(id) ON DELETE SET NULL,

  reference        text,    -- free-text audit (ex: 'daily_harvest_profit_swept')
  balance_after_usd numeric(28, 2),  -- snapshot du solde vault après ce mouvement

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_movements_portfolio
  ON public.vault_movements (portfolio_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vault_movements_position
  ON public.vault_movements (source_position_id)
  WHERE source_position_id IS NOT NULL;

ALTER TABLE public.vault_movements ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'vault_movements' AND policyname = 'vault_movements_owner_select'
  ) THEN
    CREATE POLICY vault_movements_owner_select
      ON public.vault_movements FOR SELECT
      USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.vault_movements IS
  'P12-BASELINE — Ledger immuable des mouvements du vault (dépôts/retraits). '
  'Append-only : aucun UPDATE/DELETE autorisé en prod.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. harvest_sweeps
--    Détail de chaque sweep PER_TRADE ou END_OF_DAY.
--    Lien entre une session, une position (optionnel), et un mouvement vault.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.harvest_sweeps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  session_id   uuid REFERENCES public.harvest_sessions(id) ON DELETE SET NULL,

  -- 'per_trade' | 'end_of_day'
  sweep_mode       text NOT NULL CHECK (sweep_mode IN ('per_trade', 'end_of_day')),
  gross_profit_usd numeric(28, 2) NOT NULL CHECK (gross_profit_usd > 0),
  net_sweep_usd    numeric(28, 2) NOT NULL CHECK (net_sweep_usd > 0),

  -- Position source (NULL pour end_of_day sweep global)
  position_id uuid REFERENCES public.lisa_positions(id) ON DELETE SET NULL,
  symbol      text,

  -- Lien vers le mouvement vault créé par ce sweep
  vault_movement_id uuid REFERENCES public.vault_movements(id) ON DELETE SET NULL,

  -- Statut idempotence (évite double sweep sur même position)
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('completed', 'skipped_already_swept', 'failed')),

  swept_at   timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_harvest_sweeps_portfolio
  ON public.harvest_sweeps (portfolio_id, swept_at DESC);

CREATE INDEX IF NOT EXISTS idx_harvest_sweeps_session
  ON public.harvest_sweeps (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_harvest_sweeps_position
  ON public.harvest_sweeps (position_id)
  WHERE position_id IS NOT NULL;

ALTER TABLE public.harvest_sweeps ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'harvest_sweeps' AND policyname = 'harvest_sweeps_owner_select'
  ) THEN
    CREATE POLICY harvest_sweeps_owner_select
      ON public.harvest_sweeps FOR SELECT
      USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

COMMENT ON TABLE public.harvest_sweeps IS
  'P12-BASELINE — Détail de chaque sweep PER_TRADE ou END_OF_DAY déclenché par '
  'ProfitSweepService. Complémentaire à la table vault_movements (qui est le ledger '
  'comptable) : harvest_sweeps porte la sémantique métier Harvest.';
