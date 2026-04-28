-- P3-A — Table rebound_positions : positions ouvertes par le scanner
-- mean-reversion (cf. packages/ai-analyst/src/strategies/rebound-tp.ts).
--
-- Cycle de vie :
--   1. scanRebound retourne { type: 'BUY', entry, tp1, tp2, tp3, sl, … }
--   2. INSERT row status = 'OPEN', filled_qty_pct = 100
--   3. Cron monitor (toutes les 5 min) compare le prix live au pallier
--      atteint :
--        - close >= tp1  → status='TP1_HIT', filled_qty_pct=50
--        - close >= tp2  → status='TP2_HIT', filled_qty_pct=20  (50+30 sortis)
--        - close >= tp3  → status='TP3_HIT', filled_qty_pct=0   (close totale)
--        - close <= sl   → status='SL_HIT', filled_qty_pct=0
--        - now >= time_stop_at → status='TIMEOUT', filled_qty_pct=0
--   4. realized_pnl_usd recalculé par le monitor à chaque sortie partielle.
--
-- L'enum status est un text constraint (compatible PG sans pg_dump enum).

CREATE TABLE IF NOT EXISTS public.rebound_positions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid NOT NULL,
  ticker text NOT NULL,
  -- Niveaux figés à l'ouverture (immutables après INSERT).
  entry_price numeric(18, 6) NOT NULL CHECK (entry_price > 0),
  entry_at timestamptz NOT NULL DEFAULT now(),
  tp1 numeric(18, 6) NOT NULL CHECK (tp1 > 0),
  tp2 numeric(18, 6) NOT NULL CHECK (tp2 > tp1),
  tp3 numeric(18, 6) NOT NULL CHECK (tp3 > tp2),
  sl  numeric(18, 6) NOT NULL CHECK (sl  > 0 AND sl < tp1),
  time_stop_at timestamptz NOT NULL,
  -- Status fini (text + CHECK plutôt que CREATE TYPE pour idempotence).
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN (
    'OPEN','TP1_HIT','TP2_HIT','TP3_HIT','SL_HIT','TIMEOUT','CLOSED'
  )),
  -- Quantité restante en pourcentage de la quantité initiale (100 → 0).
  filled_qty_pct numeric(5, 2) NOT NULL DEFAULT 100 CHECK (filled_qty_pct >= 0 AND filled_qty_pct <= 100),
  realized_pnl_usd numeric(18, 6) NOT NULL DEFAULT 0,
  -- Audit / observabilité.
  scanner_confidence numeric(4, 3),
  scanner_indicators jsonb,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rebound_positions_portfolio_status_idx
  ON public.rebound_positions (portfolio_id, status);

CREATE INDEX IF NOT EXISTS rebound_positions_open_time_stop_idx
  ON public.rebound_positions (time_stop_at)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS rebound_positions_ticker_idx
  ON public.rebound_positions (ticker);

-- RLS — comme pour lisa_positions, scope sur portfolio appartenant à
-- l'user. Le service backend utilise le service_role qui bypasse RLS.
-- La policy SELECT permet à un user d'accéder uniquement à ses propres
-- portfolios via la jointure portfolios.user_id = auth.uid().
ALTER TABLE public.rebound_positions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rebound_positions'
      AND policyname = 'rebound_positions_select_own'
  ) THEN
    CREATE POLICY rebound_positions_select_own ON public.rebound_positions
      FOR SELECT
      USING (
        portfolio_id IN (
          SELECT id FROM public.portfolios WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.rebound_positions_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rebound_positions_updated_at_trigger ON public.rebound_positions;
CREATE TRIGGER rebound_positions_updated_at_trigger
BEFORE UPDATE ON public.rebound_positions
FOR EACH ROW
EXECUTE FUNCTION public.rebound_positions_set_updated_at();

COMMENT ON TABLE public.rebound_positions IS
  'P3-A — positions ouvertes par scanRebound (capitulation + amorce de rebond). Sortie mécanique TP1/TP2/TP3 + SL + time stop. Cron monitor toutes les 5 min update le status.';
