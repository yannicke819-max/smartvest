-- P19x.8 (29/04/2026 02:30 UTC) — Persistance des fees détaillés par venue.
--
-- User spec : "Persister fees_in, fees_out, venue_fee_detail (JSON breakdown :
-- commission + exchange + SEC + TAF + FX si applicable) dans la table positions.
-- Exposer dans l'UI Lisa pour chaque position fermée : gross, fees_in, fees_out,
-- net (tooltip détaillé au hover)."
--
-- Avant P19x.8 : `lisa_positions.estimated_entry_cost_usd` (numeric) stockait
-- uniquement le total entry cost. Pas de breakdown, pas de exit cost séparé.
--
-- Après P19x.8 :
--   fees_in_usd        : total fees entry (numeric, equivalent estimated_entry_cost_usd
--                        kept for back-compat — nouveau code écrit les 2)
--   fees_out_usd       : total fees exit (jamais NULL post-close)
--   venue_fee_detail   : JSONB { entry: {commission, exchange, regulatory, fx, total},
--                                exit:  {commission, exchange, regulatory, fx, total} }
--                        Permet l'UI tooltip détaillé.
--
-- Idempotent : ADD COLUMN IF NOT EXISTS sur tous.

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS fees_in_usd       numeric(20, 4),
  ADD COLUMN IF NOT EXISTS fees_out_usd      numeric(20, 4),
  ADD COLUMN IF NOT EXISTS venue_fee_detail  jsonb;

COMMENT ON COLUMN public.lisa_positions.fees_in_usd IS
  'P19x.8 (29/04/2026) — Total entry fees USD (commission + exchange + regulatory + fx). '
  'Equivalent fonctionnel à estimated_entry_cost_usd (kept for back-compat). '
  'Calculé par computeVenueFeeDetail(qty, price, assetClass, venue, side).';

COMMENT ON COLUMN public.lisa_positions.fees_out_usd IS
  'P19x.8 (29/04/2026) — Total exit fees USD. NULL tant que position open. '
  'Calculé au close par paper-broker.closePosition / mechanical-trading.closePosition.';

COMMENT ON COLUMN public.lisa_positions.venue_fee_detail IS
  'P19x.8 (29/04/2026) — JSONB breakdown fees par côté (entry/exit) :'
  ' { commission, exchange, regulatory, fx, total }. '
  'Sert au tooltip UI Lisa (cf P19x.9).';
