-- P20a (01/05/2026) — Normalize legacy market codes in top_gainers_log
-- and gainers_persistence_log that used Yahoo Finance / wrong exchange codes:
--   SS  → SHG  (Shanghai Stock Exchange, official EODHD code)
--   SZ  → SHE  (Shenzhen Stock Exchange, official EODHD code)
--   TSE → T    (Tokyo Stock Exchange, official EODHD code = suffix .T)
--
-- These entries are rare (scanner was paused since 30/04 and SS/SZ/TSE
-- returned 0 EODHD screener results even before that), but the update
-- ensures the log is internally consistent post-P20a.
--
-- Safe: no FK constraints on market/exchange columns; soft update only.

UPDATE top_gainers_log
SET market = CASE
  WHEN market = 'SS'  THEN 'SHG'
  WHEN market = 'SZ'  THEN 'SHE'
  WHEN market = 'TSE' THEN 'T'
  ELSE market
END,
detected_asset_class = CASE
  WHEN detected_asset_class = 'SS'  THEN 'SHG'
  WHEN detected_asset_class = 'SZ'  THEN 'SHE'
  WHEN detected_asset_class = 'TSE' THEN 'T'
  ELSE detected_asset_class
END
WHERE market IN ('SS', 'SZ', 'TSE')
   OR detected_asset_class IN ('SS', 'SZ', 'TSE');

UPDATE gainers_persistence_log
SET market = CASE
  WHEN market = 'SS'  THEN 'SHG'
  WHEN market = 'SZ'  THEN 'SHE'
  WHEN market = 'TSE' THEN 'T'
  ELSE market
END
WHERE market IN ('SS', 'SZ', 'TSE');
