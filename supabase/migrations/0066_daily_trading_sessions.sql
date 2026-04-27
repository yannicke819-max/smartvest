-- 0066 — DAILY_HARVEST : sessions de trading journalières
--
-- Fonde le mode CapitalDisciplineMode = 'DAILY_HARVEST' (orthogonal à
-- DelegationMode, OperatingTempo, PersonalOverrideMode). Pour ce mode,
-- chaque journée de trading est une session bornée :
--   - Capital de travail fixe (workingCapitalBase)
--   - Objectif de profit journalier (montant ou %)
--   - Profits sweepés hors capital quand objectif atteint
--   - Reset journalier en début de session (timezone user)
--
-- Une ligne par (portfolio_id, session_date) — 1 session = 1 jour calendaire
-- en timezone user. UNIQUE constraint pour éviter les doublons.
--
-- États possibles (machine d'état documentée dans capital-discipline.types.ts) :
--   IDLE, ACTIVE, TARGET_NEAR, TARGET_HIT, PROFIT_SWEEP_PENDING,
--   PROFIT_SWEPT, DAILY_LOCKED, LOSS_LIMIT_HIT, SESSION_CLOSED.

CREATE TABLE IF NOT EXISTS public.daily_trading_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- Identifie la session par jour calendaire en timezone user
  session_date date NOT NULL,
  session_timezone text NOT NULL DEFAULT 'Europe/Paris',
  session_started_at timestamptz NOT NULL DEFAULT now(),
  session_closed_at timestamptz,

  -- Capital & objectifs configurés au démarrage de la session
  working_capital_start_usd numeric(28, 2) NOT NULL,
  daily_target_amount_usd numeric(28, 2),    -- soit montant
  daily_target_percent numeric(8, 4),         -- soit pourcentage
  max_loss_per_day_usd numeric(28, 2),
  max_trades_per_day integer,

  -- État courant + métriques temps réel
  state text NOT NULL DEFAULT 'IDLE'
    CHECK (state IN (
      'IDLE', 'ACTIVE', 'TARGET_NEAR', 'TARGET_HIT',
      'PROFIT_SWEEP_PENDING', 'PROFIT_SWEPT',
      'DAILY_LOCKED', 'LOSS_LIMIT_HIT', 'SESSION_CLOSED'
    )),
  realized_pnl_today_usd numeric(28, 2) NOT NULL DEFAULT 0,
  secured_pnl_today_usd numeric(28, 2) NOT NULL DEFAULT 0,
  unrealized_pnl_now_usd numeric(28, 2),
  trades_count integer NOT NULL DEFAULT 0,
  winning_trades_count integer NOT NULL DEFAULT 0,
  losing_trades_count integer NOT NULL DEFAULT 0,

  -- Audit
  last_state_transition_at timestamptz NOT NULL DEFAULT now(),
  last_state_transition_reason text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT daily_session_unique_per_day
    UNIQUE (portfolio_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_session_portfolio_date
  ON public.daily_trading_sessions (portfolio_id, session_date DESC);

CREATE INDEX IF NOT EXISTS idx_daily_session_state
  ON public.daily_trading_sessions (portfolio_id, state)
  WHERE state NOT IN ('SESSION_CLOSED');

-- RLS policy : l'utilisateur ne voit que les sessions de ses propres portfolios
ALTER TABLE public.daily_trading_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY daily_session_owner_select
  ON public.daily_trading_sessions
  FOR SELECT
  USING (
    portfolio_id IN (
      SELECT id FROM public.portfolios WHERE user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE réservés au service role (pas de policy → bloqué pour anon/auth)

-- ─────────────────────────────────────────────────────────────────────
-- Extension lisa_session_configs : capital_discipline_mode + sous-config
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS capital_discipline_mode text
    NOT NULL DEFAULT 'NONE'
    CHECK (capital_discipline_mode IN ('NONE', 'DAILY_HARVEST'));

-- Configuration JSONB du mode (uniquement utilisé si mode = 'DAILY_HARVEST').
-- Format :
--   {
--     "dailyTargetAmountUsd": 50,                   // ou null si target en %
--     "dailyTargetPercent": 0.5,                    // ou null si target en $
--     "workingCapitalBaseUsd": 10000,
--     "maxCapitalAllocationUsd": 10000,             // cap absolu
--     "profitSweepMode": "PER_TRADE" | "END_OF_DAY",
--     "stopTradingWhenTargetHit": true,
--     "allowReentryAfterTargetHit": false,
--     "maxLossPerDayUsd": 200,
--     "maxTradesPerDay": 20,
--     "allowedInstruments": ["equity", "crypto", ...],  // optionnel
--     "sessionStartTime": "09:00",
--     "sessionEndTime": "22:00",
--     "timezone": "Europe/Paris",
--     "requiresHumanApprovalAboveUsd": 100,
--     "cooldownMinutesAfterClose": 5
--   }
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS daily_harvest_config jsonb;

COMMENT ON COLUMN public.lisa_session_configs.capital_discipline_mode IS
  'Mode de discipline de capital orthogonal au DelegationMode. NONE = comportement classique. DAILY_HARVEST = sweep des profits journaliers + reset.';

COMMENT ON COLUMN public.lisa_session_configs.daily_harvest_config IS
  'Configuration JSON du mode DAILY_HARVEST. Lue uniquement si capital_discipline_mode = DAILY_HARVEST.';
