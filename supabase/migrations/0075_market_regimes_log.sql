-- P1 — Persiste l'historique des classifications de régime tactique.
--
-- Permet :
--   1. Audit a posteriori : "à 14h32 on était en BULL, sizing 1.2x → trade
--      RTX ouvert, comprendre la cohérence"
--   2. Backtests : reconstituer la séquence de régimes pour analyser
--      win-rate par régime sur l'historique
--   3. UI dashboard : courbe colorée par régime (vert BULL, rouge BEAR,
--      gris RANGE, jaune VOL_SPIKE, orange NEWS_SHOCK)
--
-- Cf. feat/market-regime (PR P1 28/04/2026).

CREATE TABLE IF NOT EXISTS public.market_regimes_log (
  id uuid primary key default gen_random_uuid(),
  classified_at timestamptz NOT NULL DEFAULT now(),
  -- Nom du régime (BULL/BEAR/RANGE/VOL_SPIKE/NEWS_SHOCK/NEUTRAL).
  regime text NOT NULL CHECK (regime IN (
    'BULL', 'BEAR', 'RANGE', 'VOL_SPIKE', 'NEWS_SHOCK', 'NEUTRAL'
  )),
  -- Inputs factuels au moment de la classification (pour reproductibilité).
  inputs jsonb NOT NULL,
  -- Conditions textuelles qui ont matché (audit-friendly, ex:
  -- ['btc_24h=+3.2% > +2%', 'funding=0.020% > 0.01%']).
  reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- Sizing/SL/TP appliqués (snapshot pour audit, le classifier peut évoluer).
  sizing_multiplier numeric(5,2) NOT NULL,
  stop_loss_pct numeric(5,3) NOT NULL,
  take_profit_pct numeric(5,3) NOT NULL,
  take_profit_ladder_pct numeric(5,3)[] NOT NULL DEFAULT ARRAY[]::numeric(5,3)[]
);

-- Index pour query "régime courant" (la dernière ligne) :
CREATE INDEX IF NOT EXISTS market_regimes_log_classified_at_desc_idx
  ON public.market_regimes_log (classified_at DESC);

-- Index pour query "transitions de régime" :
CREATE INDEX IF NOT EXISTS market_regimes_log_regime_classified_at_idx
  ON public.market_regimes_log (regime, classified_at DESC);

COMMENT ON TABLE public.market_regimes_log IS
  'P1 — historique des classifications tactiques (BULL/BEAR/RANGE/VOL_SPIKE/NEWS_SHOCK). Une ligne par classification (toutes les 5 min côté MarketRegimeService). Inputs + reasons + sizing/SL/TP snapshotted pour audit reproductible.';
