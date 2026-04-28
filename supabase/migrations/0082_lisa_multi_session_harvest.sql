-- P4-A — Schema multi-session harvest sweep windows.
--
-- ⚠️ Cette migration ne fait QUE le schéma. La logique de sweep
-- multi-fenêtre (DailySessionService refactor) est deferred — le runtime
-- continue d'opérer sur 1 sweep/jour tant que `harvest_sweep_windows_utc`
-- n'est pas consommé par DailySessionService (follow-up P4-C).
--
-- Justification spec ticket P4-A : "daily_harvest_reset doit devenir
-- multi-window: matin Europe (09h CEST), après-midi US (15h30 CEST),
-- nuit Asie (01h CEST)". Cette migration prépare la DB ; le code suit.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS).

-- Colonnes : array de fenêtres "HH:MM" UTC pendant lesquelles un sweep
-- PER_TRADE est autorisé. Format identique à session_open_utc dans
-- watchlist_universe (P4-A migration 0081).
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS harvest_sweep_windows_utc text[]
    DEFAULT ARRAY['07:00', '13:30', '23:00']::text[];

-- Override per-portfolio possible. NULL = utilise default.
COMMENT ON COLUMN public.lisa_session_configs.harvest_sweep_windows_utc IS
  'P4-A — fenêtres horaires UTC où le sweep PER_TRADE Daily Harvest est autorisé. Default 3 fenêtres (Europe matin / US PM / Asie nuit). Consommé par DailySessionService (refactor P4-C).';

-- Index utile pour debug ("quels portfolios ont une config sweep custom ?")
CREATE INDEX IF NOT EXISTS lisa_session_configs_harvest_sweep_idx
  ON public.lisa_session_configs USING gin (harvest_sweep_windows_utc);
