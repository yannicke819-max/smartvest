-- 0069 — BOT PROFITABILITY LAB Phase 1 : Foundations
--
-- Module R&D séparé du flow trading principal. Permet de :
--  1. Importer des bots externes (CSV ou API) en paper-trading
--  2. Mesurer leurs performances avec métriques standardisées
--  3. Extraire les patterns ROBUSTES pour les transférer à Lisa
--
-- Phase 1 : foundations DB + types + CRUD basique. Pas de logique
-- d'analyse ou de transfert encore (Phases 2-4).
--
-- Indépendant des tables lisa_* existantes — pas d'impact sur le flow
-- de trading principal. RLS strict (owner-only).

-- ═══════════════════════════════════════════════════════════════════
-- 1. BOT_DEFINITIONS — métadonnées des bots importés
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bot_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id uuid REFERENCES public.portfolios(id) ON DELETE SET NULL,

  -- Identité
  name text NOT NULL,
  description text,
  source_type text NOT NULL CHECK (source_type IN ('csv_import', 'api_external', 'lisa_replay', 'manual')),
  source_metadata jsonb,

  -- Capital & période
  capital_base_usd numeric(28, 2) NOT NULL,
  start_date date,
  end_date date,
  is_active boolean NOT NULL DEFAULT true,

  -- Tags / classification (asset class focus, strategy type, regime expected, etc.)
  tags text[] DEFAULT '{}',

  -- Stats agrégées (recalculées périodiquement par Phase 2 PerformanceEngine)
  total_trades integer NOT NULL DEFAULT 0,
  total_realized_pnl_usd numeric(28, 2) DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_def_user ON public.bot_definitions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_def_active ON public.bot_definitions (user_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_bot_def_tags ON public.bot_definitions USING GIN (tags);

ALTER TABLE public.bot_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bot_def_owner_select ON public.bot_definitions;
CREATE POLICY bot_def_owner_select ON public.bot_definitions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS bot_def_owner_insert ON public.bot_definitions;
CREATE POLICY bot_def_owner_insert ON public.bot_definitions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS bot_def_owner_update ON public.bot_definitions;
CREATE POLICY bot_def_owner_update ON public.bot_definitions
  FOR UPDATE USING (user_id = auth.uid());

DROP POLICY IF EXISTS bot_def_owner_delete ON public.bot_definitions;
CREATE POLICY bot_def_owner_delete ON public.bot_definitions
  FOR DELETE USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 2. BOT_PAPER_TRADES — journal normalisé des trades simulés
-- ═══════════════════════════════════════════════════════════════════
-- Format unifié quel que soit le bot source (CSV, API, replay).
-- Volume potentiellement important (millions de lignes) — index agressifs
-- + partitioning futur si nécessaire.

CREATE TABLE IF NOT EXISTS public.bot_paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bot_definitions(id) ON DELETE CASCADE,

  -- Identité du trade
  external_id text,                   -- ID dans la source originale (pour idempotence)
  symbol text NOT NULL,
  asset_class text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('long', 'short', 'long_call', 'long_put')),

  -- Entry
  entry_timestamp timestamptz NOT NULL,
  entry_price numeric(28, 10) NOT NULL,
  quantity numeric(28, 10) NOT NULL,
  entry_notional_usd numeric(28, 2) NOT NULL,

  -- Exit (null si position ouverte au moment de l'import)
  exit_timestamp timestamptz,
  exit_price numeric(28, 10),
  exit_reason text,

  -- Costs & PnL (calculés par JournalNormalizer avec mêmes hypothèses que paper-broker)
  entry_cost_usd numeric(28, 2) DEFAULT 0,
  exit_cost_usd numeric(28, 2) DEFAULT 0,
  gross_pnl_usd numeric(28, 2),
  net_pnl_usd numeric(28, 2),
  net_pnl_pct numeric(10, 4),

  -- Contexte (rempli par regime tagger Phase 2)
  market_regime text,
  vix_at_entry numeric(8, 2),
  dxy_at_entry numeric(8, 2),

  -- Source data (raw, pour debug)
  raw_payload jsonb,

  imported_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bot_trade_unique_external UNIQUE (bot_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_trades_bot_entry
  ON public.bot_paper_trades (bot_id, entry_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_bot_trades_symbol
  ON public.bot_paper_trades (bot_id, symbol);
CREATE INDEX IF NOT EXISTS idx_bot_trades_regime
  ON public.bot_paper_trades (bot_id, market_regime) WHERE market_regime IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bot_trades_closed
  ON public.bot_paper_trades (bot_id, exit_timestamp DESC) WHERE exit_timestamp IS NOT NULL;

ALTER TABLE public.bot_paper_trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bot_trades_owner_select ON public.bot_paper_trades;
CREATE POLICY bot_trades_owner_select ON public.bot_paper_trades
  FOR SELECT USING (bot_id IN (SELECT id FROM public.bot_definitions WHERE user_id = auth.uid()));

-- INSERT/UPDATE/DELETE réservés au service role (import + recalc).

-- ═══════════════════════════════════════════════════════════════════
-- 3. BOT_METRICS_DAILY — agrégats journaliers
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bot_metrics_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bot_definitions(id) ON DELETE CASCADE,
  date date NOT NULL,

  -- Activity
  trades_count integer NOT NULL DEFAULT 0,
  winning_trades integer NOT NULL DEFAULT 0,
  losing_trades integer NOT NULL DEFAULT 0,

  -- PnL
  realized_pnl_usd numeric(28, 2) NOT NULL DEFAULT 0,
  cumulative_pnl_usd numeric(28, 2) NOT NULL DEFAULT 0,
  equity_value_usd numeric(28, 2),
  daily_return_pct numeric(10, 4),

  -- Drawdown
  drawdown_from_peak_pct numeric(10, 4),
  is_new_peak boolean DEFAULT false,

  -- Costs
  total_costs_usd numeric(28, 2) DEFAULT 0,

  computed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bot_metric_unique_per_day UNIQUE (bot_id, date)
);

CREATE INDEX IF NOT EXISTS idx_bot_metrics_daily_bot
  ON public.bot_metrics_daily (bot_id, date DESC);

ALTER TABLE public.bot_metrics_daily ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bot_metrics_daily_owner ON public.bot_metrics_daily;
CREATE POLICY bot_metrics_daily_owner ON public.bot_metrics_daily
  FOR SELECT USING (bot_id IN (SELECT id FROM public.bot_definitions WHERE user_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 4. BOT_METRICS_SESSION — agrégats par session de marché (regime/volatility)
-- ═══════════════════════════════════════════════════════════════════
-- Sert à mesurer la performance d'un bot par contexte (régime risk-on,
-- crisis, low-vol, etc.) — clé pour le pattern miner Phase 3.

CREATE TABLE IF NOT EXISTS public.bot_metrics_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bot_definitions(id) ON DELETE CASCADE,

  session_kind text NOT NULL CHECK (session_kind IN (
    'market_regime', 'vix_bucket', 'asset_class', 'symbol', 'time_of_day', 'global'
  )),
  session_value text NOT NULL,        -- e.g. 'risk_on_extended', 'vix_low', 'BTC', '08:00-12:00'

  -- Stats normalisées
  trades_count integer NOT NULL DEFAULT 0,
  winning_trades integer NOT NULL DEFAULT 0,
  win_rate_pct numeric(10, 4),
  avg_win_usd numeric(28, 2),
  avg_loss_usd numeric(28, 2),
  net_pnl_usd numeric(28, 2),
  expectancy_per_trade_usd numeric(28, 2),
  profit_factor numeric(10, 4),

  -- Risk metrics
  max_drawdown_pct numeric(10, 4),
  sharpe_ratio numeric(10, 4),
  sortino_ratio numeric(10, 4),

  computed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bot_session_unique UNIQUE (bot_id, session_kind, session_value)
);

CREATE INDEX IF NOT EXISTS idx_bot_session_bot
  ON public.bot_metrics_session (bot_id, session_kind);

ALTER TABLE public.bot_metrics_session ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bot_metrics_session_owner ON public.bot_metrics_session;
CREATE POLICY bot_metrics_session_owner ON public.bot_metrics_session
  FOR SELECT USING (bot_id IN (SELECT id FROM public.bot_definitions WHERE user_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 5. BOT_PATTERNS — patterns extraits par le miner
-- ═══════════════════════════════════════════════════════════════════
-- Phase 3 — Phase 1 crée juste la table. Le pattern miner (Phase 3)
-- la peuplera.

CREATE TABLE IF NOT EXISTS public.bot_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identité
  name text NOT NULL,
  description text,
  pattern_kind text NOT NULL CHECK (pattern_kind IN (
    'entry_setup', 'exit_rule', 'risk_management', 'regime_filter', 'time_filter'
  )),

  -- Source : sur quel(s) bot(s) le pattern a été détecté
  source_bot_ids uuid[] DEFAULT '{}',

  -- Conditions (DSL JSON — ex: {"asset_class": "equity", "rsi_max": 30, "regime_in": ["risk_on"]})
  conditions jsonb NOT NULL,
  action_signal jsonb,                 -- ex: {"action": "open_long", "horizon_days": 30}

  -- Scoring (calculé par Phase 3 PatternMiner)
  observation_count integer NOT NULL DEFAULT 0,
  win_rate_pct numeric(10, 4),
  expectancy_usd numeric(28, 2),

  -- Robustesse cross-régimes (variance perf cross-régimes — clé du miner)
  robustness_score numeric(10, 4),    -- 0-100, higher = stable across regimes
  composite_score numeric(10, 4),     -- score global (robustesse × edge × sample × dd)

  -- Metadata
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validated', 'rejected', 'deprecated')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_patterns_user_score
  ON public.bot_patterns (user_id, composite_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_bot_patterns_status
  ON public.bot_patterns (user_id, status);

ALTER TABLE public.bot_patterns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bot_patterns_owner_select ON public.bot_patterns;
CREATE POLICY bot_patterns_owner_select ON public.bot_patterns
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS bot_patterns_owner_update ON public.bot_patterns;
CREATE POLICY bot_patterns_owner_update ON public.bot_patterns
  FOR UPDATE USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- 6. BOT_PATTERN_OBSERVATIONS — instances d'un pattern observées
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bot_pattern_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_id uuid NOT NULL REFERENCES public.bot_patterns(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES public.bot_definitions(id) ON DELETE CASCADE,
  trade_id uuid REFERENCES public.bot_paper_trades(id) ON DELETE SET NULL,

  -- Snapshot du contexte au moment de l'observation
  observed_at timestamptz NOT NULL,
  market_regime text,
  vix_at_observation numeric(8, 2),

  -- Résultat
  resulted_in_trade boolean NOT NULL DEFAULT false,
  trade_pnl_usd numeric(28, 2),
  trade_won boolean,

  observed_metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_pattern_obs_pattern
  ON public.bot_pattern_observations (pattern_id, observed_at DESC);

ALTER TABLE public.bot_pattern_observations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pattern_obs_owner ON public.bot_pattern_observations;
CREATE POLICY pattern_obs_owner ON public.bot_pattern_observations
  FOR SELECT USING (pattern_id IN (SELECT id FROM public.bot_patterns WHERE user_id = auth.uid()));

-- ═══════════════════════════════════════════════════════════════════
-- 7. LISA_PATTERN_ADOPTIONS — niveau d'adoption par Lisa
-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 (Transfer Layer) utilisera cette table pour décider quels
-- patterns Lisa observe / suggère / enforce.
--
-- 3 niveaux :
--   OBSERVE : pattern visible dans la mémoire, aucune action
--   SUGGEST : Lisa intègre dans son briefing
--   ENFORCE : Lisa refuse les thèses contredisant le pattern

CREATE TABLE IF NOT EXISTS public.lisa_pattern_adoptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  pattern_id uuid NOT NULL REFERENCES public.bot_patterns(id) ON DELETE CASCADE,

  adoption_level text NOT NULL CHECK (adoption_level IN ('observe', 'suggest', 'enforce')),

  -- Audit
  adopted_at timestamptz NOT NULL DEFAULT now(),
  adopted_by_user boolean NOT NULL DEFAULT true,
  adoption_notes text,

  -- Stats post-adoption (boucle feedback Phase 4)
  -- Recalculé par cron : quelles décisions Lisa ont matché ce pattern et leur résultat
  triggered_count integer NOT NULL DEFAULT 0,
  triggered_winning_count integer NOT NULL DEFAULT 0,
  triggered_total_pnl_usd numeric(28, 2) NOT NULL DEFAULT 0,
  last_triggered_at timestamptz,

  -- Lifecycle
  is_active boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  deactivation_reason text,

  CONSTRAINT pattern_adoption_unique UNIQUE (portfolio_id, pattern_id)
);

CREATE INDEX IF NOT EXISTS idx_pattern_adoption_active
  ON public.lisa_pattern_adoptions (portfolio_id, is_active) WHERE is_active = true;

ALTER TABLE public.lisa_pattern_adoptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pattern_adoption_owner_select ON public.lisa_pattern_adoptions;
CREATE POLICY pattern_adoption_owner_select ON public.lisa_pattern_adoptions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS pattern_adoption_owner_insert ON public.lisa_pattern_adoptions;
CREATE POLICY pattern_adoption_owner_insert ON public.lisa_pattern_adoptions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS pattern_adoption_owner_update ON public.lisa_pattern_adoptions;
CREATE POLICY pattern_adoption_owner_update ON public.lisa_pattern_adoptions
  FOR UPDATE USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════

COMMENT ON TABLE public.bot_definitions IS
  'BOT LAB Phase 1 : métadonnées des bots externes importés pour analyse de profitabilité.';
COMMENT ON TABLE public.bot_paper_trades IS
  'BOT LAB Phase 1 : journal normalisé des trades simulés. Coûts cohérents avec paper-broker (10bps entry+exit).';
COMMENT ON TABLE public.bot_metrics_daily IS
  'BOT LAB Phase 2 : agrégats journaliers par bot. Recalculés par PerformanceEngine.';
COMMENT ON TABLE public.bot_metrics_session IS
  'BOT LAB Phase 2 : performance par contexte (regime, VIX bucket, asset class, time-of-day). Clé pour pattern miner.';
COMMENT ON TABLE public.bot_patterns IS
  'BOT LAB Phase 3 : patterns extraits par le miner. Score robustesse cross-régimes + composite.';
COMMENT ON TABLE public.bot_pattern_observations IS
  'BOT LAB Phase 3 : instances détectées des patterns avec leurs résultats.';
COMMENT ON TABLE public.lisa_pattern_adoptions IS
  'BOT LAB Phase 4 : niveau d’adoption par Lisa (observe/suggest/enforce) avec boucle feedback.';
