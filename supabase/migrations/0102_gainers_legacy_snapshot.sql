-- 0102 — ADR-005 BLOC 2 : table gainers_legacy_snapshot (non-régression univers)
--
-- Capture l'univers V1 de référence au moment du déploiement.
-- Le UniverseGuardService vérifie au boot que l'univers courant scanné
-- est un sur-ensemble de cette table (K_current ≥ K_legacy).
--
-- watchlist_hash = SHA256(concat de tous les symbols triés alphabétiquement).
-- Drift détecté si hash change entre déploiements successifs → alerte observability.
--
-- Alimentée UNE FOIS par scripts/audit-universe-legacy.ts au premier déploiement.
-- Seeding initial inclus ci-dessous avec l'univers mega12 (conservateur).
-- Le script full-universe est à relancer pour inclure sp500+crypto.

CREATE TABLE IF NOT EXISTS public.gainers_legacy_snapshot (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol        TEXT        NOT NULL,
  exchange      TEXT        NOT NULL,
  asset_class   TEXT        NOT NULL CHECK (asset_class IN ('equity', 'crypto')),
  watchlist_hash TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gainers_legacy_snapshot_symbol_exchange_unique UNIQUE (symbol, exchange)
);

CREATE INDEX IF NOT EXISTS gainers_legacy_snapshot_exchange_idx
  ON public.gainers_legacy_snapshot (exchange, asset_class);

-- Seed conservateur : MEGA12 + crypto_tradable (minimum garanti).
-- Le script audit-universe-legacy.ts complétera avec sp500+nasdaq100 au premier run.
INSERT INTO public.gainers_legacy_snapshot (symbol, exchange, asset_class, watchlist_hash)
VALUES
  ('AAPL.US',   'US',      'equity', 'seed_mega12_v1'),
  ('MSFT.US',   'US',      'equity', 'seed_mega12_v1'),
  ('NVDA.US',   'US',      'equity', 'seed_mega12_v1'),
  ('META.US',   'US',      'equity', 'seed_mega12_v1'),
  ('GOOGL.US',  'US',      'equity', 'seed_mega12_v1'),
  ('TSLA.US',   'US',      'equity', 'seed_mega12_v1'),
  ('AMD.US',    'US',      'equity', 'seed_mega12_v1'),
  ('AVGO.US',   'US',      'equity', 'seed_mega12_v1'),
  ('SPY.US',    'US',      'equity', 'seed_mega12_v1'),
  ('QQQ.US',    'US',      'equity', 'seed_mega12_v1'),
  ('IWM.US',    'US',      'equity', 'seed_mega12_v1'),
  ('XOM.US',    'US',      'equity', 'seed_mega12_v1'),
  ('BTC-USD.CC','BINANCE',  'crypto', 'seed_mega12_v1'),
  ('ETH-USD.CC','BINANCE',  'crypto', 'seed_mega12_v1'),
  ('SOL-USD.CC','BINANCE',  'crypto', 'seed_mega12_v1')
ON CONFLICT (symbol, exchange) DO NOTHING;

COMMENT ON TABLE public.gainers_legacy_snapshot IS
  'Univers V1 de référence pour la non-régression du scanner Gainers. '
  'ADR-005 BLOC 2 (PR3). Seeding initial mega12+crypto. '
  'Compléter via scripts/audit-universe-legacy.ts après premier déploiement.';

COMMENT ON COLUMN public.gainers_legacy_snapshot.watchlist_hash IS
  'SHA256(sorted symbols) à la date du seeding. '
  'Drift alert si hash diverge entre déploiements.';
