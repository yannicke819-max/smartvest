-- 0197 — Imitation learning : extension du contrefactuel des décisions de close
-- vers l'horizon J+10 (oversold) + news cause→effet + contexte.
--
-- Le CloseDecisionCaptureService capture déjà chaque close (position_close_decisions)
-- + labellise GOOD/EARLY/OK à +60min (horizon gainers). Pour l'oversold (hold J+10),
-- on veut savoir si fermer EN AVANCE valait mieux que tenir jusqu'à l'échéance.
-- On ajoute : le contexte (danger-zone / oversold-early), l'échéance, un snapshot
-- news au moment du close (pour la causalité), et la trajectoire J+1/3/5/10.
ALTER TABLE position_close_decisions
  ADD COLUMN IF NOT EXISTS context TEXT,                       -- 'danger_zone' | 'oversold_early' | 'manual_other'
  ADD COLUMN IF NOT EXISTS was_manual_control BOOLEAN,
  ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ,            -- échéance initiale (J+10 oversold)
  ADD COLUMN IF NOT EXISTS hours_to_deadline NUMERIC,          -- restant au moment du close
  ADD COLUMN IF NOT EXISTS news_count INT,
  ADD COLUMN IF NOT EXISTS news_min_sentiment NUMERIC,
  ADD COLUMN IF NOT EXISTS news_snapshot JSONB,                -- [{title, sentiment, ageHours, source}]
  -- Contrefactuel jusqu'à l'échéance (rempli par cron une fois les dates passées)
  ADD COLUMN IF NOT EXISTS price_j1 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_j3 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_j5 NUMERIC,
  ADD COLUMN IF NOT EXISTS price_j10 NUMERIC,
  ADD COLUMN IF NOT EXISTS pnl_if_held_to_deadline_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS deadline_verdict TEXT,              -- 'CLOSE_BETTER' | 'HELD_BETTER' | 'NEUTRAL'
  ADD COLUMN IF NOT EXISTS deadline_labeled_at TIMESTAMPTZ;
