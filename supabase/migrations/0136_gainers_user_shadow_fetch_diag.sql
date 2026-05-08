-- 0136_gainers_user_shadow_fetch_diag
--
-- PR #286 — Diagnostic JSONB pour comprendre pourquoi le simulator
-- shadow produit 0/385 real outcomes sur asia_equity malgré le fix
-- range fetch (PR #284).
--
-- Schema fetch_diag :
--   {
--     "step1": {
--       "endpoint": "eodhd_getCandles",
--       "interval": "5m",
--       "rangeMode": true,
--       "fromTs": <number>,
--       "toTs": <number>,
--       "inputSymbol": "300161.SHE",
--       "requestedSymbol": "300161.SHE",
--       "rawCount": <number>,         -- pre-filter close>0
--       "validClose": <number>,       -- post-filter
--       "nulls": <number>,            -- rawCount - validClose
--       "ms": <number>                 -- latency
--     },
--     "step2": { ... endpoint: "eodhd_ticks", ... },
--     "step3": { ... endpoint: "eodhd_getCandles_1m", ... },
--     "step4": { ... endpoint: "eodhd_getCandles_5m_default", ... },
--     "selectedStep": 1 | 2 | 3 | 4 | null,
--     "forwardCount": <number>,        -- post normalize+filter par startTs
--     "outcome": "ok" | "no_data" | "error"
--   }
--
-- Permet SQL post-mortem de chaque sim Asia : quel endpoint a réussi, quel
-- a retourné empty, quel inputSymbol vs requestedSymbol, etc.

ALTER TABLE public.gainers_user_shadow_signals
  ADD COLUMN IF NOT EXISTS fetch_diag JSONB;

COMMENT ON COLUMN public.gainers_user_shadow_signals.fetch_diag IS
  'PR #286 — Diagnostic chain fetch (4 steps : 5m_range / ticks_range / 1m_range / 5m_default+filter). '
  'Permet SQL post-mortem sans grep Fly logs. Schema documenté dans la migration.';

-- Index partiel pour analyse rapide des Asia NO_DATA
CREATE INDEX IF NOT EXISTS gainers_user_shadow_fetch_diag_no_data_idx
  ON public.gainers_user_shadow_signals(asset_class, created_at DESC)
  WHERE asset_class = 'asia_equity'
    AND sim_results->'baseline_60m'->>'outcome' = 'NO_DATA';
