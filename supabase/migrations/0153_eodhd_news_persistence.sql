-- ÉTAPE 1 — Persistance news EODHD + economic events.
--
-- Constat 23/05/2026 : aucune trace historique des news consommées par le
-- système (NewsAggregatorService les jette après usage). Impossible de
-- prouver a posteriori "tel trade a-t-il été précédé d'une news ?".
--
-- Cette migration crée 2 tables append-only pour persister :
--   1. eodhd_news_articles : news ticker-spécifiques (Reuters/Bloomberg/etc.)
--   2. eodhd_economic_events : macro calendar (FOMC/ECB/BoJ/PBoC/PCE/NFP…)
--
-- Tables alimentées par crons env-gated (EODHD_NEWS_PERSIST_ENABLED,
-- EODHD_ECONOMIC_EVENTS_ENABLED). Aucune écriture tant que pas activé.
--
-- Réutilisable par :
--   - DailyCatalystBriefService (refactor Phase 1bis : grounding Gemini)
--   - Phase 2 (future) : filtre scanner reject_post_news_fresh_strong_pos
--   - Audit / backtest / analytics offline

CREATE TABLE IF NOT EXISTS public.eodhd_news_articles (
  id          BIGSERIAL PRIMARY KEY,
  ticker      TEXT NOT NULL,
  -- Identifiant stable côté EODHD (date + hash titre) pour dedupe.
  external_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT,
  source_url  TEXT,
  -- Polarity ∈ [-1, +1]. -1 très négatif, +1 très positif.
  sentiment_polarity NUMERIC(4,3),
  -- Scores granulaires si EODHD les fournit (neg/neu/pos somment à ~1).
  sentiment_neg NUMERIC(4,3),
  sentiment_neu NUMERIC(4,3),
  sentiment_pos NUMERIC(4,3),
  -- Tags / symbols complémentaires (autres tickers cités).
  tags        TEXT[],
  related_symbols TEXT[],
  raw_payload JSONB,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eodhd_news_unique UNIQUE (ticker, external_id)
);

CREATE INDEX IF NOT EXISTS idx_eodhd_news_ticker_published
  ON public.eodhd_news_articles (ticker, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_eodhd_news_published
  ON public.eodhd_news_articles (published_at DESC);

CREATE TABLE IF NOT EXISTS public.eodhd_economic_events (
  id          BIGSERIAL PRIMARY KEY,
  -- ex: 'PCE Price Index', 'FOMC Rate Decision', 'NFP'
  event_name  TEXT NOT NULL,
  country     TEXT NOT NULL,  -- 'US', 'EU', 'JP', 'CN', 'KR', 'GB', ...
  event_date  TIMESTAMPTZ NOT NULL,
  -- 'high', 'medium', 'low' selon EODHD
  importance  TEXT,
  actual      NUMERIC,
  previous    NUMERIC,
  estimate    NUMERIC,
  unit        TEXT,            -- '%', 'K', 'B$', ...
  raw_payload JSONB,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eodhd_econ_event_unique UNIQUE (country, event_name, event_date)
);

CREATE INDEX IF NOT EXISTS idx_eodhd_econ_date
  ON public.eodhd_economic_events (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_eodhd_econ_country_date
  ON public.eodhd_economic_events (country, event_date DESC);

-- RLS désactivée (tables append-only système, pas user-scoped).
ALTER TABLE public.eodhd_news_articles DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.eodhd_economic_events DISABLE ROW LEVEL SECURITY;
