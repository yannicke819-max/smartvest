-- 0064 — Phase 5 : lisa_trade_outcomes (apprentissage continu multi-dim)
--
-- Pour chaque position fermée, capture le CONTEXTE au moment de l'ouverture
-- (regime, VIX, DXY, conviction, news catalyst) + le RÉSULTAT (return %,
-- durée, raison de close). Permet à Lisa d'agréger des stats contextuelles
-- (ex. "conv 7-8 sur ce regime → 67% win sur 15 trades") qu'elle injecte
-- dans son briefing pour calibrer ses futures propositions.
--
-- Contrairement à un modèle ML re-trainé, c'est juste un agrégat SQL lu en
-- temps réel et formaté en texte. Cohérent avec l'architecture actuelle
-- (corpus, mémoire Phase 3) et CLAUDE.md (toute action explicable).

CREATE TABLE IF NOT EXISTS public.lisa_trade_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  position_id uuid NOT NULL,
  proposal_id uuid,
  thesis_id uuid,

  symbol text NOT NULL,
  asset_class text NOT NULL,
  direction text NOT NULL,

  -- Contexte au moment de l'ouverture (snapshot)
  open_regime text,
  open_vix numeric(8,2),
  open_dxy numeric(8,2),
  open_conviction integer,
  open_news_top_score integer,
  open_news_top_catalyst text,

  -- Résultat
  open_at timestamptz NOT NULL,
  close_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL,
  entry_price numeric(28,10) NOT NULL,
  exit_price numeric(28,10) NOT NULL,
  return_pct numeric(10,4) NOT NULL,
  return_usd numeric(28,2) NOT NULL,
  close_reason text NOT NULL, -- closed_stop, closed_target, closed_invalidated, closed_user, etc.

  recorded_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT outcomes_position_unique UNIQUE (position_id)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_portfolio_close
  ON public.lisa_trade_outcomes(portfolio_id, close_at DESC);

CREATE INDEX IF NOT EXISTS idx_outcomes_regime
  ON public.lisa_trade_outcomes(portfolio_id, open_regime, close_at DESC);

CREATE INDEX IF NOT EXISTS idx_outcomes_symbol
  ON public.lisa_trade_outcomes(portfolio_id, symbol, close_at DESC);

CREATE INDEX IF NOT EXISTS idx_outcomes_conviction
  ON public.lisa_trade_outcomes(portfolio_id, open_conviction, close_at DESC);

COMMENT ON TABLE public.lisa_trade_outcomes IS
  'Phase 5 : captures contextuelles des positions fermées pour apprentissage continu Lisa. Agrégé par LisaPerformanceAnalyticsService et injecté dans le briefing.';
