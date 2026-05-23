-- Phase D-1 — Event-driven engine audit table.
--
-- Capture chaque évaluation event (planifiée, snapshot, trigger, force-close)
-- pour replay/audit complet. Append-only.
--
-- En V1 (D-1) on persiste seulement les ÉVALUATIONS prévues et les snapshots
-- pre-event. Le trigger/exécution viendra en D-2.

CREATE TABLE IF NOT EXISTS public.event_engine_trades (
  id              BIGSERIAL PRIMARY KEY,
  -- Référence au row dans eodhd_economic_events (event_name, country, event_date)
  event_name      TEXT NOT NULL,
  event_country   TEXT NOT NULL,
  event_date      TIMESTAMPTZ NOT NULL,
  event_importance TEXT,
  -- Ticker watché pour cet event
  symbol          TEXT NOT NULL,
  -- Lifecycle :
  --   scheduled       : event détecté, en watch
  --   pre_snapshot    : snapshot prix T-5min capturé
  --   triggered       : trigger direction post-event, ouverture (D-2)
  --   force_closed    : fenêtre T+window expirée, sortie (D-3)
  --   skipped         : pas de trigger valide ou rejected par filtres
  status          TEXT NOT NULL DEFAULT 'scheduled',
  -- Snapshot T-5min
  snapshot_price          NUMERIC(16,6),
  snapshot_volume         NUMERIC(20,4),
  snapshot_taken_at       TIMESTAMPTZ,
  -- Trigger T+5min (D-2)
  trigger_price           NUMERIC(16,6),
  trigger_direction       TEXT,  -- 'long' | 'short' | null
  trigger_delta_pct       NUMERIC(8,4),
  trigger_taken_at        TIMESTAMPTZ,
  -- Exit T+window (D-3)
  exit_price              NUMERIC(16,6),
  exit_reason             TEXT,
  exit_taken_at           TIMESTAMPTZ,
  realized_pnl_pct        NUMERIC(8,4),
  -- Audit
  raw_payload     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_engine_uniq UNIQUE (event_name, event_country, event_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_event_engine_status_event
  ON public.event_engine_trades (status, event_date);
CREATE INDEX IF NOT EXISTS idx_event_engine_event_date
  ON public.event_engine_trades (event_date DESC);

ALTER TABLE public.event_engine_trades DISABLE ROW LEVEL SECURITY;
