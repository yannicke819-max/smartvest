-- P8-MULTI-TIMEFRAME-PERSISTENCE — Forward-compatible schema (P6 + P8 + P9).
--
-- Contient :
--   1. Table paper_trades — registre append-only des trades du scanner
--      Gainers (P6 logique paper-broker, P8 persistance multi-TF,
--      P9 features ML + outcome label).
--   2. lisa_session_configs : 2 colonnes config gainers (topN, minScore)
--      pour respecter la priorité query > DB > env > default(20).
--   3. Table gainers_persistence_log — snapshots historiques de l'endpoint
--      /lisa/gainers-persistence-snapshot (rétention 7j cron). Chaque ligne
--      = 1 capture × N candidats.
--
-- IMPORTANT — paper_trades expose dès cette migration TOUTES les colonnes
-- finales (P6 + P8 + P9), même si certaines ne sont peuplées qu'à partir
-- de PR ultérieurs. Justification : éviter ALTER TABLE à chaque ticket
-- du flux gainers (forward-compatible per user instruction 28/04).

CREATE TABLE IF NOT EXISTS public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- Identification de la position
  symbol text NOT NULL,
  asset_class text NOT NULL,
  exchange text,

  -- Cycle de vie
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),

  -- Pricing
  entry_price numeric(20, 8) NOT NULL,
  exit_price numeric(20, 8),
  size_usd numeric(12, 2) NOT NULL,
  stop_loss numeric(20, 8) NOT NULL,
  take_profit numeric(20, 8) NOT NULL,

  -- PnL (rempli au close)
  pnl_usd numeric(12, 2),
  pnl_pct numeric(8, 4),
  hold_duration_seconds integer,

  -- Provenance
  strategy text NOT NULL DEFAULT 'top_gainers_v1',
  scanner_proposal_id uuid,
  scanner_position_id uuid,

  -- ── P8 — Persistance multi-TF au moment de l'open ─────────────────────
  persistence_score_at_entry numeric(3, 2),
  persistence_count_at_entry text,
  tf_changes_at_entry jsonb,

  -- ── P9 — Features ML + outcome (forward-compatible) ───────────────────
  features_at_entry jsonb,
  p_win_at_entry numeric(4, 3),
  outcome_label smallint,
  model_version_at_entry text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_trades_status_open_idx
  ON public.paper_trades (portfolio_id, status)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS paper_trades_closed_at_idx
  ON public.paper_trades (closed_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS paper_trades_user_idx
  ON public.paper_trades (user_id, opened_at DESC);

CREATE INDEX IF NOT EXISTS paper_trades_strategy_outcome_idx
  ON public.paper_trades (strategy, outcome_label, closed_at DESC)
  WHERE outcome_label IS NOT NULL;

ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'paper_trades'
      AND policyname = 'paper_trades_select_owner'
  ) THEN
    CREATE POLICY paper_trades_select_owner ON public.paper_trades
      FOR SELECT USING (auth.uid() = user_id);
  END IF;
END $$;

COMMENT ON TABLE public.paper_trades IS
  'P6+P8+P9 — Trades paper-broker du scanner Gainers. Forward-compatible : colonnes P9 (features_at_entry, p_win_at_entry, outcome_label, model_version_at_entry) ajoutées dès maintenant pour éviter ALTER TABLE.';

-- ─────────────────────────────────────────────────────────────────────────────
-- lisa_session_configs : config user du scanner persistance
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_persistence_top_n integer NOT NULL DEFAULT 20;

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_min_persistence_score numeric(3, 2) NOT NULL DEFAULT 0.67;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_top_n_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_top_n_check
      CHECK (gainers_persistence_top_n BETWEEN 5 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_min_score_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_min_score_check
      CHECK (gainers_min_persistence_score BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON COLUMN public.lisa_session_configs.gainers_persistence_top_n IS
  'P8 — Nombre de valeurs scannées au top 1min (5..100, default 20). Priorité lecture : query string > DB > env GAINERS_PERSISTENCE_TOP_N > 20.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_min_persistence_score IS
  'P8 — Seuil min de persistenceScore pour ouvrir une position (0..1, default 0.67 = 4/6 TF positifs). Priorité : DB > env GAINERS_MIN_PERSISTENCE_SCORE > 0.67.';

-- ─────────────────────────────────────────────────────────────────────────────
-- gainers_persistence_log — append-only des snapshots /persistence-snapshot
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.gainers_persistence_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at timestamptz NOT NULL DEFAULT now(),
  top_n integer NOT NULL CHECK (top_n BETWEEN 5 AND 100),
  markets_scanned text[] NOT NULL DEFAULT '{}',
  snapshot_json jsonb NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gainers_persistence_log_captured_at_idx
  ON public.gainers_persistence_log (captured_at DESC);

ALTER TABLE public.gainers_persistence_log ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'gainers_persistence_log'
      AND policyname = 'gainers_persistence_log_select_authenticated'
  ) THEN
    CREATE POLICY gainers_persistence_log_select_authenticated ON public.gainers_persistence_log
      FOR SELECT USING (auth.role() = 'authenticated');
  END IF;
END $$;

COMMENT ON TABLE public.gainers_persistence_log IS
  'P8 — Snapshots historiques de l''endpoint /lisa/gainers-persistence-snapshot (rétention 7j via cron, à venir). Chaque ligne = 1 capture × N candidats.';
