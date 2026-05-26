-- Migration 0168 — Live Trader Agent : portfolio dédié + decision log + memory store
-- ----------------------------------------------------------------------
-- Crée le portfolio "Trader Agent" (capital $10k) qui sera piloté à 100%
-- par Gemini Pro via LiveTraderAgentService (cron 5min). Plus les tables
-- d'audit + apprentissage (post-mortem nightly).
-- ----------------------------------------------------------------------

-- 1. Portfolio dédié (parent FK)
INSERT INTO public.portfolios (id, user_id, name, base_currency)
VALUES (
  'b0000001-0000-0000-0000-000000000001',
  '5f164201-9736-4867-8756-a1653d65fd1c',
  'Trader Agent (Gemini Pro)',
  'USD'
)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW();

-- 2. Session config dédiée
INSERT INTO public.lisa_session_configs (
  user_id, portfolio_id, profile, capital_usd, strategy_mode, autopilot_enabled, kill_switch_active,
  gainers_max_open_positions, gainers_position_pct, gainers_max_per_cycle, gainers_cash_reserve_pct,
  gainers_min_persistence_score, gainers_min_path_efficiency,
  gainers_default_tp_pct, gainers_default_sl_pct,
  gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto,
  daily_cost_budget_usd, autopilot_cycle_minutes, gainers_cycle_minutes,
  base_currency
)
VALUES (
  '5f164201-9736-4867-8756-a1653d65fd1c',
  'b0000001-0000-0000-0000-000000000001',
  'hyper_active', 10000,
  -- strategy_mode IS NULL → scanner gainers ne le scannera PAS (TraderAgent
  -- pilote à 100%, autonome du pipeline scanner standard). autopilot_enabled
  -- reste true pour observabilité dans les status endpoints.
  NULL, true, false,
  10, 10.0, 2, 0,
  0, 0,
  2.0, 1.2,
  true, true, true, true,
  50, 5, 5,
  'USD'
)
ON CONFLICT (portfolio_id) DO UPDATE SET
  capital_usd = EXCLUDED.capital_usd,
  strategy_mode = EXCLUDED.strategy_mode,
  autopilot_enabled = EXCLUDED.autopilot_enabled,
  kill_switch_active = EXCLUDED.kill_switch_active,
  updated_at = NOW();

-- 3. Decision log (chaque appel Gemini Pro + apply result)
CREATE TABLE IF NOT EXISTS public.trader_agent_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL,
  cycle_started_at TIMESTAMPTZ NOT NULL,
  -- Input à Gemini (snapshot envoyé)
  input_state JSONB NOT NULL,
  input_candidates JSONB,
  input_macro JSONB,
  input_news_summary JSONB,
  input_memory_lessons JSONB,
  -- Output Gemini brut
  gemini_raw_response TEXT,
  gemini_parsed JSONB,
  gemini_provider TEXT,
  gemini_latency_ms INT,
  gemini_cost_usd NUMERIC(10, 6),
  -- Décision finale
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'open_directional', 'open_pairs', 'close', 'scale_in', 'trail_stop', 'hold', 'skip_low_confidence', 'skip_safety_bound'
  )),
  target_symbol TEXT,
  direction TEXT CHECK (direction IN ('long', 'short') OR direction IS NULL),
  notional_usd NUMERIC(12, 2),
  confidence NUMERIC(3, 2),
  thesis TEXT,
  -- Apply result
  action_applied BOOLEAN NOT NULL DEFAULT false,
  applied_position_id UUID,
  apply_error TEXT,
  CONSTRAINT fk_portfolio FOREIGN KEY (portfolio_id) REFERENCES public.lisa_session_configs(portfolio_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trader_agent_decided_at
  ON public.trader_agent_decisions(decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_trader_agent_portfolio
  ON public.trader_agent_decisions(portfolio_id, decided_at DESC);

-- 4. Memory store (lessons learned from nightly post-mortem)
CREATE TABLE IF NOT EXISTS public.trader_agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  portfolio_id UUID NOT NULL,
  -- Catégorie de la lesson (winning_pattern, losing_pattern, risk_observation, market_regime_rule, etc.)
  lesson_kind TEXT NOT NULL,
  -- Texte court (1-2 phrases) injecté dans la system prompt du jour suivant
  lesson_text TEXT NOT NULL,
  -- Score 0-1 de confiance dans la lesson (Gemini peut grader)
  confidence NUMERIC(3, 2) DEFAULT 0.7,
  -- Times "used" : à chaque fois qu'on injecte cette lesson dans une system prompt
  injection_count INT NOT NULL DEFAULT 0,
  -- Date du post-mortem qui a généré cette lesson
  derived_from_date DATE,
  -- Payload optionnel (raw post-mortem data, exemples trades)
  payload JSONB,
  -- Active = true : injecté dans system prompt. Désactivé manuellement si lesson devient obsolète.
  is_active BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT fk_portfolio FOREIGN KEY (portfolio_id) REFERENCES public.lisa_session_configs(portfolio_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trader_agent_memory_active
  ON public.trader_agent_memory(portfolio_id, is_active, created_at DESC) WHERE is_active = true;

COMMENT ON TABLE public.trader_agent_decisions IS
  'Audit complet des décisions LiveTraderAgentService (Gemini Pro cron 5min).';
COMMENT ON TABLE public.trader_agent_memory IS
  'Lessons apprises par post-mortem nightly. Injectées dans system prompt du lendemain.';
