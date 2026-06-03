-- Migration 0188 — Tracker indicateurs positions (Étape 3)
--
-- Snapshot append-only des indicateurs techniques + prix live pour chaque
-- position ouverte, capturé toutes les 2 min par PositionIndicatorsTrackerService.
--
-- Objectif : collecter le MFE/MAE PRÉCIS + le contexte indicateurs pendant la
-- vie d'une position, pour :
--   - Quantifier l'edge laissé par exits prématurés (closed_choppy / orphan)
--     sur des trades PROPRES (pipeline réparé) — l'audit one-shot sur trades
--     de dev était inexploitable.
--   - A/B mesurable des règles d'exit (ex: closed_choppy afterMinutes 20→40).
--   - Calibration empirique continue des seuils indicateurs (confidence
--     dynamique selon le nombre de snapshots accumulés).
--
-- Volume estimé : 2min × ~5 positions × 4 portfolios × heures marché ≈ 5-15k
-- rows/jour. Rétention 30j (cleanup cron applicatif à venir) ≈ 300k rows.

CREATE TABLE IF NOT EXISTS public.position_indicators_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Liens
  position_id UUID NOT NULL,
  portfolio_id UUID NOT NULL,
  symbol TEXT NOT NULL,

  -- Prix & PnL live
  live_price NUMERIC,
  live_price_source TEXT,          -- eodhd / twelvedata / binance / fallback_*
  entry_price NUMERIC,
  pnl_pct NUMERIC,                 -- signé selon direction
  pnl_usd NUMERIC,
  age_minutes NUMERIC,             -- depuis entry_timestamp

  -- MFE/MAE intra-tracker (calculés en cumulant sur la vie de la position)
  mfe_pct NUMERIC,                 -- best favorable depuis entry
  mae_pct NUMERIC,                 -- worst adverse depuis entry
  mae_r_ratio NUMERIC,             -- |mae| / |sl_distance|

  -- Indicateurs EODHD technical (computed sur candles 5m)
  rsi14 NUMERIC,
  macd NUMERIC,
  macd_signal NUMERIC,
  macd_hist NUMERIC,
  atr14 NUMERIC,
  atr14_pct NUMERIC,
  bb_upper NUMERIC,
  bb_middle NUMERIC,
  bb_lower NUMERIC,
  bb_pct_b NUMERIC,
  stoch_rsi_k NUMERIC,
  stoch_rsi_d NUMERIC,
  adx14 NUMERIC,
  cci20 NUMERIC,
  obv NUMERIC,
  obv_trend_pct NUMERIC,

  -- Indicateurs in-house / TwelveData
  vwap NUMERIC,
  ema9 NUMERIC,
  ema21 NUMERIC,
  supertrend_signal TEXT,          -- bullish / bearish / null

  -- Indicateurs scanner existants (réutilisés depuis top_gainers pipeline)
  persistence_score NUMERIC,
  persistence_count TEXT,
  path_efficiency NUMERIC,
  momentum_gradient NUMERIC,
  momentum_acceleration NUMERIC,
  momentum_verticality NUMERIC,
  bucket TEXT,

  -- Signaux confluence (Phase B+ — MFI / ROC / volume fade)
  mfi14 NUMERIC,
  roc5 NUMERIC,
  confluence_count INT,            -- 0-3 signaux exhaustion/entry
  confluence_signals JSONB,        -- { mfi_div, roc_flat, vol_fade }

  -- Forward-compat : tout indicateur futur sans ALTER TABLE
  raw_payload JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timeline d'une position (query principale du Reporter + UI)
CREATE INDEX IF NOT EXISTS idx_pos_ind_snapshot_position
  ON public.position_indicators_snapshot (position_id, captured_at DESC);

-- Agrégation par portfolio (Reporter 15min)
CREATE INDEX IF NOT EXISTS idx_pos_ind_snapshot_portfolio
  ON public.position_indicators_snapshot (portfolio_id, captured_at DESC);

-- Cleanup / queries récentes
CREATE INDEX IF NOT EXISTS idx_pos_ind_snapshot_captured
  ON public.position_indicators_snapshot (captured_at DESC);

COMMENT ON TABLE public.position_indicators_snapshot IS
  'Snapshot append-only des indicateurs + prix live par position ouverte (cron 2min). Sert à mesurer MFE/MAE précis, A/B les exits, calibrer les seuils indicateurs en continu. Rétention 30j.';
COMMENT ON COLUMN public.position_indicators_snapshot.mfe_pct IS
  'Max Favorable Excursion depuis entry. Calculé en cumulant le best price sur la vie de la position (vs peak_pre_exit qui sous-estime via polling discret).';
COMMENT ON COLUMN public.position_indicators_snapshot.confluence_count IS
  'Nombre de signaux confluence (MFI bearish div / ROC flattening / volume fade). Backtest Phase B+ : ≥2 = 74% WR à TP+2%/SL-1.5% sur 60min.';

-- RLS — service_role only (table interne tracker, pas user-facing direct ;
-- l'UI passe par un endpoint API service-role)
ALTER TABLE public.position_indicators_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pos_ind_snapshot_service_only" ON public.position_indicators_snapshot;
CREATE POLICY "pos_ind_snapshot_service_only" ON public.position_indicators_snapshot
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
