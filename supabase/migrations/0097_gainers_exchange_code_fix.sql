-- P20a (01/05/2026) — Normalize legacy market codes used by the scanner:
--   SS  → SHG  (Shanghai Stock Exchange, official EODHD code)
--   SZ  → SHE  (Shenzhen Stock Exchange, official EODHD code)
--   TSE → T    (Tokyo Stock Exchange, official EODHD code = suffix .T)
--
-- These entries are rare (scanner was paused since 30/04 and SS/SZ/TSE
-- returned 0 EODHD screener results even before that), but the update
-- ensures the log is internally consistent post-P20a.
--
-- HOTFIX 02/05/2026 — original migration assumed gainers_persistence_log had
-- a `market` column (it doesn't — actual columns are markets_scanned text[]
-- and snapshot_json jsonb per migration 0086). Rewritten to:
--   1. Idempotent column-existence guards (information_schema.columns)
--   2. top_gainers_log update unchanged (column market exists per 0084)
--   3. gainers_persistence_log handled via array_replace on markets_scanned
--      (the text[] column that actually holds market codes per 0086)
--
-- Safe: no FK constraints on market/exchange columns; soft update only.

-- ─── top_gainers_log : columns market + detected_asset_class exist (mig 0084) ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'top_gainers_log' AND column_name = 'market'
  ) THEN
    UPDATE public.top_gainers_log
    SET market = CASE
      WHEN market = 'SS'  THEN 'SHG'
      WHEN market = 'SZ'  THEN 'SHE'
      WHEN market = 'TSE' THEN 'T'
      ELSE market
    END
    WHERE market IN ('SS', 'SZ', 'TSE');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'top_gainers_log' AND column_name = 'detected_asset_class'
  ) THEN
    UPDATE public.top_gainers_log
    SET detected_asset_class = CASE
      WHEN detected_asset_class = 'SS'  THEN 'SHG'
      WHEN detected_asset_class = 'SZ'  THEN 'SHE'
      WHEN detected_asset_class = 'TSE' THEN 'T'
      ELSE detected_asset_class
    END
    WHERE detected_asset_class IN ('SS', 'SZ', 'TSE');
  END IF;
END $$;

-- ─── gainers_persistence_log : codes vivent dans markets_scanned text[] (mig 0086) ──
-- array_replace remplace toutes les occurrences d'un code par un autre dans le tableau.
-- Trois passes (une par code legacy) — idempotent : si le code n'est pas présent, NOOP.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'gainers_persistence_log' AND column_name = 'markets_scanned'
  ) THEN
    UPDATE public.gainers_persistence_log
    SET markets_scanned = array_replace(markets_scanned, 'SS', 'SHG')
    WHERE 'SS' = ANY(markets_scanned);

    UPDATE public.gainers_persistence_log
    SET markets_scanned = array_replace(markets_scanned, 'SZ', 'SHE')
    WHERE 'SZ' = ANY(markets_scanned);

    UPDATE public.gainers_persistence_log
    SET markets_scanned = array_replace(markets_scanned, 'TSE', 'T')
    WHERE 'TSE' = ANY(markets_scanned);
  END IF;
END $$;
