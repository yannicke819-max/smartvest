-- P5-PIVOT-TOP-GAINERS — Log de chaque candidat scanné par TopGainersScannerService.
--
-- Permet :
--   1. Audit a posteriori : "à 14:32 le scanner a vu ce gainer, l'a traité OUI/NON"
--   2. Backtest manuel : ré-évaluer la stratégie sur la base du historique
--   3. UI dashboard : top gainers du jour, breakdown par market
--
-- Append-only. Pas de cleanup automatique — pruning à venir si volume excessif
-- (15min × 50 candidats × 24h = ~5000 rows/jour).

CREATE TABLE IF NOT EXISTS public.top_gainers_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  -- market = classe d'actif normalisée (TopGainerAssetClass)
  market text NOT NULL CHECK (market IN (
    'us_equity_large', 'us_equity_small_mid',
    'eu_equity', 'asia_equity',
    'crypto_major', 'crypto_alt',
    'fx_major', 'fx_cross',
    'commodity'
  )),
  -- exchange = source data (NYSE, NASDAQ, LSE, XETRA, BINANCE, FOREX, etc.)
  exchange text NOT NULL,
  -- Snapshots des metrics scannés
  close_price numeric(18, 6) NOT NULL CHECK (close_price > 0),
  high_price numeric(18, 6) NOT NULL CHECK (high_price > 0),
  change_pct numeric(10, 4) NOT NULL,
  volume bigint NOT NULL CHECK (volume >= 0),
  avg_vol_50d bigint NOT NULL CHECK (avg_vol_50d >= 0),
  market_cap_usd numeric(28, 2) NOT NULL CHECK (market_cap_usd >= 0),
  -- Score composite filter
  score numeric(4, 3) NOT NULL CHECK (score >= 0 AND score <= 1),
  -- Décision : passed (top N retenu) / filtered (ne passe pas les seuils) / opened (position ouverte)
  decision text NOT NULL CHECK (decision IN ('opened', 'passed', 'filtered')),
  -- Si decision='opened', lien vers la lisa_position créée
  opened_position_id uuid,
  -- Raisons rejet si decision='filtered' (e.g. "changePct=4<5,gap-and-fade")
  filter_reasons text[],
  -- Asset class détectée (= market la plupart du temps mais peut diverger
  -- si le caller a override)
  detected_asset_class text,
  portfolio_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index principaux
CREATE INDEX IF NOT EXISTS top_gainers_log_captured_at_desc_idx
  ON public.top_gainers_log (captured_at DESC);

CREATE INDEX IF NOT EXISTS top_gainers_log_symbol_captured_at_idx
  ON public.top_gainers_log (symbol, captured_at DESC);

CREATE INDEX IF NOT EXISTS top_gainers_log_market_captured_at_idx
  ON public.top_gainers_log (market, captured_at DESC);

CREATE INDEX IF NOT EXISTS top_gainers_log_decision_idx
  ON public.top_gainers_log (decision, captured_at DESC);

CREATE INDEX IF NOT EXISTS top_gainers_log_portfolio_idx
  ON public.top_gainers_log (portfolio_id, captured_at DESC)
  WHERE portfolio_id IS NOT NULL;

-- RLS — service_role write, authenticated SELECT pour /lisa UI affichage
ALTER TABLE public.top_gainers_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'top_gainers_log'
      AND policyname = 'top_gainers_log_select_authenticated'
  ) THEN
    CREATE POLICY top_gainers_log_select_authenticated ON public.top_gainers_log
      FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

COMMENT ON TABLE public.top_gainers_log IS
  'P5-PIVOT-TOP-GAINERS — log append-only des candidats scannés par TopGainersScannerService cron 15min. market = classe d''actif (us_equity_large/eu_equity/crypto_major/fx_major/etc.). decision = opened/passed/filtered.';
