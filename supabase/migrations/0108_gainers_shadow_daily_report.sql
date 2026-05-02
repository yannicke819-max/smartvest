-- 0108 — ADR-005 Phase 3.2 PR6.2 — table gainers_shadow_daily_report
--
-- Aggregation quotidienne du shadow run pour monitoring sans hammering la table
-- gainers_v1_shadow_signals append-only à chaque appel dashboard.
--
-- Cron 23:30 UTC chaque jour : INSERT 1 row par jour calendaire UTC.
-- Si rerun (idempotence) : ON CONFLICT (report_date) DO UPDATE.
--
-- Notification automatique (à wirer) si :
--   - 0 signaux ACCEPT pendant 48h (cadence trop faible pour atteindre 30 en 28j)
--   - avg_slippage_pct > 2× expected (anomalie fill systématique)
--   - cadence < 0.5 ACCEPT/jour sur fenêtre 7j (idem)

CREATE TABLE IF NOT EXISTS public.gainers_shadow_daily_report (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  report_date   DATE        NOT NULL UNIQUE,

  -- Counts
  total_signals INT         NOT NULL DEFAULT 0,
  accept_count  INT         NOT NULL DEFAULT 0,
  reject_count  INT         NOT NULL DEFAULT 0,
  closed_count  INT         NOT NULL DEFAULT 0,
  win_count     INT         NOT NULL DEFAULT 0,
  loss_count    INT         NOT NULL DEFAULT 0,

  -- Stats win-rate / PnL
  win_rate          NUMERIC(5,4),     -- wins / closed_with_pnl, NULL si closed=0
  avg_realized_pnl_pct NUMERIC(8,5),
  cumulative_pnl_pct   NUMERIC(8,5),

  -- Slippage (lien ADR-005 §11.3)
  avg_slippage_pct      NUMERIC(7,5),
  anomalous_fill_count  INT NOT NULL DEFAULT 0,

  -- Divergence legacy
  divergence_count INT NOT NULL DEFAULT 0,
  divergence_pct   NUMERIC(5,4),

  -- Trigger breakdown JSON: { "PULLBACK_HL_FIBO": N, "VWAP_RECLAIM": M }
  trigger_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Anomaly flags pour notification (à read par alerting)
  zero_signals_flag        BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE si accept_count=0 ET aucun signal hier non plus
  high_slippage_flag       BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE si avg_slippage > 0.6%
  low_cadence_flag         BOOLEAN NOT NULL DEFAULT FALSE,  -- TRUE si avg accept/jour 7j < 0.5

  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gainers_shadow_daily_report_date_desc_idx
  ON public.gainers_shadow_daily_report (report_date DESC);

CREATE INDEX IF NOT EXISTS gainers_shadow_daily_report_anomaly_idx
  ON public.gainers_shadow_daily_report (report_date DESC)
  WHERE zero_signals_flag = TRUE OR high_slippage_flag = TRUE OR low_cadence_flag = TRUE;

COMMENT ON TABLE public.gainers_shadow_daily_report IS
  'ADR-005 Phase 3.2 PR6.2 — aggregation quotidienne du shadow run. '
  'Cron 23:30 UTC. Idempotent (UNIQUE report_date). Source : gainers_v1_shadow_signals.';

COMMENT ON COLUMN public.gainers_shadow_daily_report.zero_signals_flag IS
  'TRUE si accept_count=0 sur ce jour ET hier (= 48h sans signal). '
  'Notification opérateur : cadence trop faible, risque de ne pas atteindre 30 ACCEPT en 28j.';

COMMENT ON COLUMN public.gainers_shadow_daily_report.high_slippage_flag IS
  'TRUE si avg_slippage_pct > 0.006 (= 2× expected ADR-005 §11.3 cap 0.30%). '
  'Notification : anomalie fill systématique.';

COMMENT ON COLUMN public.gainers_shadow_daily_report.low_cadence_flag IS
  'TRUE si moyenne accept/jour sur fenêtre 7j < 0.5. '
  'Notification : risque ETA bascule live > 28j.';
