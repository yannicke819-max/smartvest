-- P4-A — Couverture H24 watchlist multi-bourses.
--
-- Ajoute exchange + session_window à `watchlist_universe` pour permettre au
-- scanner de filtrer dynamiquement les watchlists actives selon l'heure UTC.
-- Sans cette dimension, Lisa scanne 100% US et est aveugle 17h/jour entre
-- close NYSE 21:00 UTC et open NYSE 14:30 UTC.
--
-- Bourses ajoutées :
--   CAC40    .PA  Euronext Paris    07:00-15:30 UTC  (09:00-17:30 CEST)
--   DAX40    .DE  Xetra Frankfurt   07:00-15:30 UTC
--   FTSE100  .L   London Stock Exch 08:00-16:30 UTC
--   Nikkei225 .T  Tokyo Stock Exch  00:00-06:00 UTC
--   HSI50    .HK  Hong Kong Exch    01:30-08:00 UTC

-- ── Schema additions ─────────────────────────────────────────────────

ALTER TABLE public.watchlist_universe
  ADD COLUMN IF NOT EXISTS exchange text NOT NULL DEFAULT 'US';

ALTER TABLE public.watchlist_universe
  ADD COLUMN IF NOT EXISTS session_open_utc time;

ALTER TABLE public.watchlist_universe
  ADD COLUMN IF NOT EXISTS session_close_utc time;

ALTER TABLE public.watchlist_universe
  ADD COLUMN IF NOT EXISTS ticker_suffix text;

CREATE INDEX IF NOT EXISTS watchlist_universe_exchange_session_idx
  ON public.watchlist_universe (exchange, session_open_utc);

-- ── Patch des watchlists US existantes ───────────────────────────────

UPDATE public.watchlist_universe
SET
  exchange = 'US',
  session_open_utc = '14:30',
  session_close_utc = '21:00',
  ticker_suffix = '.US'
WHERE name IN ('mega12', 'nasdaq100', 'sp500');

-- ── Seeds nouveaux univers ───────────────────────────────────────────

-- CAC 40 (Paris) — ~40 large-caps français
INSERT INTO public.watchlist_universe (name, exchange, session_open_utc, session_close_utc, ticker_suffix, description, tickers)
VALUES (
  'cac40',
  'EURONEXT',
  '07:00',
  '15:30',
  '.PA',
  'CAC 40 (Euronext Paris) — 40 large-caps français. Session 07:00-15:30 UTC = 09:00-17:30 CEST.',
  ARRAY[
    'AIR.PA','AI.PA','MC.PA','OR.PA','BNP.PA','SAN.PA','SU.PA','TTE.PA','SGO.PA','VIV.PA',
    'CS.PA','BN.PA','EN.PA','RI.PA','RNO.PA','ENGI.PA','VIE.PA','GLE.PA','ML.PA','HO.PA',
    'CAP.PA','DG.PA','EL.PA','KER.PA','LR.PA','PUB.PA','SAF.PA','STM.PA','SW.PA','TEP.PA',
    'URW.PA','VK.PA','WLN.PA','ACA.PA','CA.PA','DSY.PA','FR.PA','LI.PA','POM.PA','RMS.PA'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- DAX 40 (Xetra Frankfurt)
INSERT INTO public.watchlist_universe (name, exchange, session_open_utc, session_close_utc, ticker_suffix, description, tickers)
VALUES (
  'dax40',
  'XETRA',
  '07:00',
  '15:30',
  '.DE',
  'DAX 40 (Xetra Frankfurt) — 40 large-caps allemands. Session 07:00-15:30 UTC.',
  ARRAY[
    'SAP.DE','SIE.DE','ALV.DE','DTE.DE','BAYN.DE','MBG.DE','BMW.DE','VOW3.DE','MUV2.DE','ADS.DE',
    'BAS.DE','DBK.DE','IFX.DE','HEN3.DE','VNA.DE','EOAN.DE','RWE.DE','BEI.DE','PUM.DE','DHL.DE',
    'AIR.DE','DTG.DE','MTX.DE','SHL.DE','CON.DE','FRE.DE','HEI.DE','SY1.DE','MRK.DE','RHM.DE',
    'P911.DE','PAH3.DE','QIA.DE','SRT3.DE','HNR1.DE','CBK.DE','ZAL.DE','ENR.DE','BRN3.DE','LIN.DE'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- FTSE 100 (London Stock Exchange) — top 50 par capitalisation
INSERT INTO public.watchlist_universe (name, exchange, session_open_utc, session_close_utc, ticker_suffix, description, tickers)
VALUES (
  'ftse100',
  'LSE',
  '08:00',
  '16:30',
  '.L',
  'FTSE 100 top 50 (London Stock Exchange). Session 08:00-16:30 UTC. Chevauchement US 13:30-16:30 UTC = double signal.',
  ARRAY[
    'AZN.L','SHEL.L','HSBA.L','ULVR.L','BP.L','RIO.L','GSK.L','BATS.L','REL.L','LSEG.L',
    'CPG.L','GLEN.L','VOD.L','BARC.L','LLOY.L','NWG.L','PRU.L','TSCO.L','III.L','AAL.L',
    'AHT.L','ANTO.L','BA.L','CRDA.L','DGE.L','EXPN.L','FLTR.L','GLPG.L','HLN.L','IMB.L',
    'INF.L','LGEN.L','LON.L','MNG.L','MRO.L','NG.L','PHNX.L','RKT.L','RTO.L','SBRY.L',
    'SDR.L','SGE.L','SGRO.L','SMDS.L','SMIN.L','SN.L','SVT.L','TW.L','UU.L','WTB.L'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- Nikkei 225 (Tokyo Stock Exchange) — top 30 par capitalisation
INSERT INTO public.watchlist_universe (name, exchange, session_open_utc, session_close_utc, ticker_suffix, description, tickers)
VALUES (
  'nikkei225',
  'TSE',
  '00:00',
  '06:00',
  '.T',
  'Nikkei 225 top 30 (Tokyo Stock Exchange). Session 00:00-06:00 UTC = couverture nuit Asie.',
  ARRAY[
    '7203.T','6758.T','9984.T','8306.T','6861.T','9433.T','8035.T','6098.T','4063.T','8316.T',
    '9432.T','6594.T','7974.T','4502.T','6367.T','6981.T','4661.T','7267.T','8058.T','7741.T',
    '6273.T','6857.T','9434.T','8001.T','8031.T','4543.T','6902.T','6526.T','3382.T','4519.T'
  ]
)
ON CONFLICT (name) DO NOTHING;

-- Hang Seng (Hong Kong Exchange) — top 30
INSERT INTO public.watchlist_universe (name, exchange, session_open_utc, session_close_utc, ticker_suffix, description, tickers)
VALUES (
  'hsi50',
  'HKEX',
  '01:30',
  '08:00',
  '.HK',
  'Hang Seng top 30 (Hong Kong Exchange). Session 01:30-08:00 UTC. Chevauchement Europe 07:00-08:00 UTC.',
  ARRAY[
    '0700.HK','0941.HK','1299.HK','3690.HK','9988.HK','0005.HK','0939.HK','1398.HK','3988.HK','2318.HK',
    '0388.HK','0001.HK','0066.HK','1810.HK','9618.HK','0883.HK','0386.HK','1113.HK','2628.HK','1109.HK',
    '0857.HK','0027.HK','0011.HK','0016.HK','0002.HK','0006.HK','0288.HK','0322.HK','1928.HK','0823.HK'
  ]
)
ON CONFLICT (name) DO NOTHING;

COMMENT ON COLUMN public.watchlist_universe.exchange IS
  'P4-A — Code bourse (US/EURONEXT/XETRA/LSE/TSE/HKEX). Permet routing fetcher EODHD via le suffixe.';
COMMENT ON COLUMN public.watchlist_universe.session_open_utc IS
  'P4-A — Heure ouverture session UTC (TIME). Le scanner active la watchlist seulement pendant cette fenêtre.';
COMMENT ON COLUMN public.watchlist_universe.session_close_utc IS
  'P4-A — Heure clôture session UTC. Idem.';
COMMENT ON COLUMN public.watchlist_universe.ticker_suffix IS
  'P4-A — Suffixe ticker EODHD (.US/.PA/.DE/.L/.T/.HK). Informatif — les tickers stockés contiennent déjà le suffixe.';
