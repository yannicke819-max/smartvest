-- Migration 0169 — Market Close Reports : comparatif 5 portfolios par session
-- ----------------------------------------------------------------------
-- Crée la table market_close_reports qui agrège PnL/fees/win-rate par
-- portfolio à chaque cloche de bourse (Asia/EU/US) + wrap-up quotidien France.
-- Alimente l'endpoint /admin/market-close-reports/latest pour comparatif live.
-- ----------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.market_close_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_kind TEXT NOT NULL CHECK (session_kind IN ('asia_close', 'eu_close', 'us_close', 'daily_wrap')),
  -- Fenêtre d'agrégation (typically since last session close)
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  -- Comparison data : un row par portfolio dans `portfolio_breakdown`
  -- Shape: [{ portfolio_id, name, closed_count, wins, gross_pnl, fees, net_pnl, win_rate_pct, best_trade, worst_trade, avg_hold_min }]
  portfolio_breakdown JSONB NOT NULL,
  -- Synthèse globale
  total_net_pnl_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_closed_count INT NOT NULL DEFAULT 0,
  winner_portfolio_id UUID,
  loser_portfolio_id UUID,
  -- Target progress vers $200/jour (basé sur le total cumulé jour)
  target_progress_pct NUMERIC(6, 2),
  -- Narrative Gemini Pro (optionnel) — 3-5 phrases analyse comparative
  ai_narrative TEXT,
  ai_provider TEXT,
  ai_cost_usd NUMERIC(8, 4),
  -- Audit
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_market_close_reports_captured_at
  ON public.market_close_reports(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_close_reports_session
  ON public.market_close_reports(session_kind, captured_at DESC);

COMMENT ON TABLE public.market_close_reports IS
  'Comparatif 5 portfolios (main + 3 shadows + trader_agent) à chaque cloche de bourse + wrap-up jour France.';
