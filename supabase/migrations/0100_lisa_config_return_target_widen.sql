-- Fix "numeric field overflow" on PUT /lisa/config/:id when user enters
-- annual return targets ≥ 100 (e.g. aspirational 150% annual on a high-risk
-- scalping portfolio). Frontend convention is percentage-as-number
-- (placeholder "ex: 25" = 25%), but numeric(6, 4) caps at 99.9999.
--
-- Expanding to numeric(8, 4) gives max 9999.9999 — generous headroom for
-- absurd-but-valid values without losing the 4-decimal precision used for
-- daily targets like 0.0500 (= 0.05%).
--
-- Same column shape change for monthly/annual to keep the trio consistent.

ALTER TABLE public.lisa_session_configs
  ALTER COLUMN return_target_daily_pct   TYPE numeric(8, 4),
  ALTER COLUMN return_target_monthly_pct TYPE numeric(8, 4),
  ALTER COLUMN return_target_annual_pct  TYPE numeric(8, 4);
