-- 0106 — ADR-007 Kelly sizing (PR #207a) — add kelly_fraction_suggested to shadow signals
--
-- Persiste la fraction Kelly suggérée à chaque signal ACCEPT pour audit post-hoc :
-- vérifier la cohérence shadow vs simulation vs prod live.
--
-- Half-Kelly default (clamp [0, 0.25]) per ADR-007 §3.2.

ALTER TABLE public.gainers_v1_shadow_signals
  ADD COLUMN IF NOT EXISTS kelly_fraction_suggested NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS kelly_inputs JSONB;

COMMENT ON COLUMN public.gainers_v1_shadow_signals.kelly_fraction_suggested IS
  'Fraction Kelly suggérée (half-Kelly default, clamp [0, 0.25]). '
  'Calculée par KellySizingService à partir du wilson lower bound + payoff ratio. '
  'NULL si REJECT ou si données insuffisantes (n < 30 sample baseline).';

COMMENT ON COLUMN public.gainers_v1_shadow_signals.kelly_inputs IS
  'JSONB inputs : {win_rate_lower_wilson, payoff_ratio, equity_ref, n_sample, '
  'full_kelly, half_kelly_applied} — pour audit + recalibrage.';
