-- 0158_sizing_ab_shadow_signals.sql
-- A/B test sizing : concentration vs diversification (24/05).
--
-- Hypothèse à tester : pour le edge actuel du scanner gainers (queue droite
-- rare à +10%, R/R 0.54), est-il préférable de concentrer en peu de positions
-- grosses ou diluer sur beaucoup de petites ?
--
-- Bucket A — concentrated : max 3 pos × $2800 = $8400 deployed
-- Bucket B — diversified  : max 12 pos × $700  = $8400 deployed
-- Baseline (real)         : max 5 pos × $787   = $3935 (status quo)
--
-- Test SHADOW only — pas d'impact sur le trading réel. Mirror les PnL réels
-- des positions lisa_positions associées, scaled au notional du bucket.
--
-- Append-only, retention 90j (cleanup cron later si volume > 100k rows).

CREATE TABLE IF NOT EXISTS public.sizing_ab_shadow_signals (
  id              BIGSERIAL PRIMARY KEY,
  bucket          TEXT NOT NULL CHECK (bucket IN ('A_concentrated', 'B_diversified', 'baseline')),
  signal_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  symbol          TEXT NOT NULL,
  asset_class     TEXT,
  -- Lien vers la position réelle ouverte par le scanner (pour mirror le close)
  scanner_position_id UUID REFERENCES public.lisa_positions(id) ON DELETE SET NULL,
  -- Sizing simulé
  notional_usd    NUMERIC(12,2) NOT NULL,
  -- Combien de shadow positions ce bucket avait ouvertes au moment du signal
  capacity_at_signal INT NOT NULL DEFAULT 0,
  max_positions   INT NOT NULL,
  -- Décision du bucket
  decision        TEXT NOT NULL CHECK (decision IN ('shadow_opened', 'shadow_capacity_full', 'shadow_skipped')),
  decision_reason TEXT,
  -- Mirror du close réel (rempli par cron daily ou hook close)
  closed_at       TIMESTAMPTZ,
  closed_status   TEXT, -- ex 'closed_target', 'closed_stop', etc.
  realized_pnl_usd NUMERIC(14,4),
  realized_pnl_pct NUMERIC(10,4),
  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sab_bucket_signal_at
  ON public.sizing_ab_shadow_signals (bucket, signal_at DESC);

CREATE INDEX IF NOT EXISTS idx_sab_scanner_position
  ON public.sizing_ab_shadow_signals (scanner_position_id)
  WHERE scanner_position_id IS NOT NULL;

-- Buckets indexable pour le daily report aggregate
CREATE INDEX IF NOT EXISTS idx_sab_bucket_closed
  ON public.sizing_ab_shadow_signals (bucket, closed_at DESC)
  WHERE closed_at IS NOT NULL;

ALTER TABLE public.sizing_ab_shadow_signals DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.sizing_ab_shadow_signals IS
  'Shadow A/B test sizing concentration vs diversification (24/05). Append-only.';
