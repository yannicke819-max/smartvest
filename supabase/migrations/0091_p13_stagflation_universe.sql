-- 0091 — P13 : univers stagflation_hedge + crypto_tradable dans watchlist_universe
--
-- Ajoute 2 nouvelles watchlists :
--
--   stagflation_hedge — ~35 tickers ETF/stocks optimaux en régime stagflation :
--     or/argent (physique + miners), énergie, obligations, défensives,
--     protection inflation (TIPS, IVOL). Session = heures US (14:30-21:00 UTC).
--     Le scanner EODHD graceful-skip si le ticker n'est pas couvert par le plan.
--
--   crypto_tradable — BTC, ETH, SOL via paper broker Binance.
--     Session = 24/7 (00:00-23:59 UTC). Le runtime utilise Binance pour le prix live.
--
-- Idempotent : ON CONFLICT (name) DO NOTHING — sûr à rejouer.
-- Pas de DROP, pas d'ALTER TABLE sur les données existantes.
--
-- Source de vérité TS : packages/ai-analyst/src/strategies/universes.ts
--   → STAGFLATION_HEDGE_UNIVERSE, CRYPTO_TRADABLE_UNIVERSE, REGIME_TICKER_MAP

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. stagflation_hedge
--    Tickers US-listés pour régime stagflation/inflation/risk_off/growth_slowdown.
--    session_open_utc/close_utc = heures marché US (NYSE/NASDAQ ETFs).
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.watchlist_universe (
  name,
  exchange,
  session_open_utc,
  session_close_utc,
  ticker_suffix,
  description,
  tickers
)
VALUES (
  'stagflation_hedge',
  'NYSE',
  '14:30',
  '21:00',
  '.US',
  'P13 — Univers stagflation hedge : or/argent (physique + miners), énergie (pétrole, XLE), '
  'obligations (TLT, IEF), protection inflation (TIPS, SCHP, IVOL), défensives (XLP, XLU, KO, PG, JNJ, WMT, COST, MCD). '
  'Tickers US-listés. Graceful skip si EODHD plan ne couvre pas le ticker.',
  ARRAY[
    -- Or physique ETFs
    'GLD.US', 'IAU.US', 'PHYS.US',
    -- Miners or large-cap + junior
    'GDX.US', 'GDXJ.US',
    -- Miners or individuels
    'NEM.US', 'AEM.US', 'GOLD.US',
    -- Royalties or
    'FNV.US', 'WPM.US',
    -- Argent physique + miners
    'SLV.US', 'SIL.US',
    'AG.US', 'PAAS.US',
    -- Énergie pétrole ETFs
    'USO.US', 'BNO.US',
    -- Énergie secteur ETFs
    'XLE.US', 'XOP.US',
    -- Majors énergie + services
    'OXY.US', 'CVX.US', 'COP.US', 'EOG.US', 'SLB.US',
    -- Obligations long/medium
    'TLT.US', 'IEF.US',
    -- Protection inflation ETFs
    'TIPS.US', 'SCHP.US', 'IVOL.US',
    -- Défensives ETFs
    'XLP.US', 'XLU.US',
    -- Consommation de base
    'KO.US', 'PG.US', 'JNJ.US', 'WMT.US', 'COST.US', 'MCD.US'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. crypto_tradable
--    BTC, ETH, SOL via paper broker Binance. H24.
--    Format EODHD : XXX-USD.CC. Le runtime utilise getLivePrice() → Binance.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.watchlist_universe (
  name,
  exchange,
  session_open_utc,
  session_close_utc,
  ticker_suffix,
  description,
  tickers
)
VALUES (
  'crypto_tradable',
  'BINANCE',
  '00:00',
  '23:59',
  '.CC',
  'P13 — Crypto tradable via paper broker Binance : BTC, ETH, SOL. '
  'Session H24 (00:00-23:59 UTC). Le prix live vient de Binance (getLivePrice), '
  'pas EODHD. Graceful skip si Binance indisponible.',
  ARRAY[
    'BTC-USD.CC', 'ETH-USD.CC', 'SOL-USD.CC'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- Comments
-- ─────────────────────────────────────────────────────────────────────────────
COMMENT ON TABLE public.watchlist_universe IS
  'Watchlists de tickers par exchange et session UTC. '
  'P3-C : sp500/nasdaq100/mega12. P4-A : cac40/dax40/ftse100/nikkei225/hsi50. '
  'P13 : stagflation_hedge/crypto_tradable.';
