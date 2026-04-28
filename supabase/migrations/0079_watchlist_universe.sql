-- P3-C — Table des watchlists par nom (sp500/nasdaq100/mega12/custom).
--
-- Source de vérité runtime pour le scanner rebound-tp. La constante
-- TS `packages/ai-analyst/src/strategies/universes.ts` reste la source
-- de vérité documentaire et le fallback côté code si la DB est down.
-- Sync manuel : à chaque update du fichier TS, mettre à jour cette
-- table via une migration corrective (cf. CLAUDE.md règle universe).

CREATE TABLE IF NOT EXISTS public.watchlist_universe (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  tickers text[] NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS watchlist_universe_name_idx
  ON public.watchlist_universe (name);

ALTER TABLE public.watchlist_universe ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'watchlist_universe'
      AND policyname = 'watchlist_universe_select_authenticated'
  ) THEN
    CREATE POLICY watchlist_universe_select_authenticated ON public.watchlist_universe
      FOR SELECT
      USING (auth.role() = 'authenticated');
  END IF;
END $$;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.watchlist_universe_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS watchlist_universe_updated_at_trigger ON public.watchlist_universe;
CREATE TRIGGER watchlist_universe_updated_at_trigger
BEFORE UPDATE ON public.watchlist_universe
FOR EACH ROW
EXECUTE FUNCTION public.watchlist_universe_set_updated_at();

-- ── Seeds initiaux ─────────────────────────────────────────────────

INSERT INTO public.watchlist_universe (name, description, tickers)
VALUES (
  'mega12',
  'Mega-caps US legacy (P3-A.2). Watchlist conservatrice 12 tickers liquides — fallback en cas de coût EODHD à plafonner.',
  ARRAY[
    'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
    'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US'
  ]
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.watchlist_universe (name, description, tickers)
VALUES (
  'nasdaq100',
  'NASDAQ-100 (~84 tickers). Tech-heavy, recouvrement avec sp500 sur les mega-caps.',
  ARRAY[
    'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'GOOG.US', 'META.US',
    'TSLA.US', 'AVGO.US', 'COST.US', 'NFLX.US', 'TMUS.US', 'ADBE.US', 'AMD.US',
    'PEP.US', 'CSCO.US', 'INTC.US', 'CMCSA.US', 'TXN.US', 'QCOM.US', 'AMAT.US',
    'BKNG.US', 'INTU.US', 'AMGN.US', 'HON.US', 'ISRG.US', 'VRTX.US', 'ADP.US',
    'GILD.US', 'PANW.US', 'KLAC.US', 'LRCX.US', 'REGN.US', 'SBUX.US', 'MU.US',
    'MELI.US', 'MDLZ.US', 'PYPL.US', 'CRWD.US', 'CDNS.US', 'SNPS.US', 'CTAS.US',
    'MAR.US', 'CHTR.US', 'ORLY.US', 'ABNB.US', 'ASML.US', 'AZN.US', 'DASH.US',
    'WDAY.US', 'NXPI.US', 'ROP.US', 'PCAR.US', 'PAYX.US', 'MNST.US', 'ROST.US',
    'CPRT.US', 'KDP.US', 'ADSK.US', 'FAST.US', 'ODFL.US', 'EA.US', 'EXC.US',
    'KHC.US', 'CSGP.US', 'CTSH.US', 'IDXX.US', 'BIIB.US', 'TTWO.US', 'XEL.US',
    'GEHC.US', 'CCEP.US', 'ON.US', 'DDOG.US', 'TEAM.US', 'CDW.US', 'FANG.US',
    'ARM.US', 'ZS.US', 'ANSS.US', 'TTD.US', 'MRVL.US', 'WBD.US', 'PDD.US'
  ]
)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.watchlist_universe (name, description, tickers)
VALUES (
  'sp500',
  'S&P 500 ~200 top par capitalisation (~85% pondération index). Univers principal P3-C pour passer 0.06 → 2-4 signaux/jour.',
  ARRAY[
    'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'GOOG.US', 'META.US', 'TSLA.US',
    'AVGO.US', 'BRK-B.US', 'LLY.US', 'JPM.US', 'V.US', 'XOM.US', 'WMT.US', 'UNH.US',
    'MA.US', 'PG.US', 'JNJ.US', 'HD.US', 'COST.US', 'ORCL.US', 'NFLX.US', 'ABBV.US',
    'BAC.US', 'CRM.US', 'KO.US', 'CVX.US', 'MRK.US', 'AMD.US', 'PEP.US', 'TMO.US',
    'ADBE.US', 'CSCO.US', 'LIN.US', 'ABT.US', 'WFC.US', 'MCD.US', 'ACN.US', 'NOW.US',
    'IBM.US', 'TXN.US', 'GE.US', 'PM.US', 'INTU.US', 'DIS.US', 'AXP.US', 'CAT.US',
    'GS.US', 'ISRG.US',
    'BKNG.US', 'MS.US', 'VZ.US', 'RTX.US', 'PFE.US', 'T.US', 'NEE.US', 'AMGN.US',
    'BLK.US', 'TJX.US', 'SCHW.US', 'C.US', 'BX.US', 'BSX.US', 'SYK.US', 'AMAT.US',
    'PGR.US', 'LOW.US', 'BMY.US', 'ETN.US', 'PANW.US', 'HON.US', 'TMUS.US', 'VRTX.US',
    'UNP.US', 'PLD.US', 'CMCSA.US', 'ADP.US', 'COP.US', 'GILD.US', 'CB.US', 'DE.US',
    'ANET.US', 'SBUX.US', 'KLAC.US', 'MDT.US', 'MMC.US', 'BA.US', 'NKE.US', 'LRCX.US',
    'LMT.US', 'ELV.US', 'CI.US', 'MU.US', 'INTC.US', 'ICE.US', 'MO.US', 'SO.US',
    'AMT.US', 'EQIX.US',
    'GEV.US', 'ADI.US', 'WM.US', 'CRWD.US', 'DUK.US', 'CME.US', 'SHW.US', 'WELL.US',
    'APH.US', 'CDNS.US', 'CMG.US', 'PYPL.US', 'KKR.US', 'SNPS.US', 'EOG.US', 'AON.US',
    'ZTS.US', 'MCK.US', 'USB.US', 'ITW.US', 'PNC.US', 'COF.US', 'TGT.US', 'MMM.US',
    'MAR.US', 'CL.US', 'NOC.US', 'GD.US', 'FCX.US', 'F.US', 'TFC.US', 'EMR.US',
    'PH.US', 'MCO.US', 'HCA.US', 'ECL.US', 'MSI.US', 'CSX.US', 'APD.US', 'ORLY.US',
    'AJG.US', 'CARR.US', 'OKE.US', 'BDX.US', 'PCAR.US', 'WMB.US', 'NSC.US', 'TT.US',
    'AFL.US', 'TRV.US',
    'ROP.US', 'FI.US', 'PSA.US', 'NXPI.US', 'AZO.US', 'JCI.US', 'O.US', 'PSX.US',
    'KMB.US', 'SLB.US', 'AIG.US', 'GM.US', 'CHTR.US', 'NEM.US', 'AEP.US', 'MET.US',
    'COR.US', 'ADSK.US', 'SPGI.US', 'BK.US', 'D.US', 'ROST.US', 'TEL.US', 'AMP.US',
    'STZ.US', 'KHC.US', 'GIS.US', 'KMI.US', 'EW.US', 'TRGP.US', 'CTSH.US', 'EXC.US',
    'PRU.US', 'A.US', 'PCG.US', 'SRE.US', 'CCI.US', 'DLR.US', 'ALL.US', 'MNST.US',
    'YUM.US', 'WCN.US', 'GWW.US', 'PWR.US', 'VST.US', 'PAYX.US', 'KR.US', 'OXY.US',
    'CTVA.US', 'LHX.US'
  ]
)
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE public.watchlist_universe IS
  'P3-C — watchlists nommées (sp500/nasdaq100/mega12). Source runtime pour le scanner rebound-tp. Mirror de packages/ai-analyst/src/strategies/universes.ts (sync manuel).';
