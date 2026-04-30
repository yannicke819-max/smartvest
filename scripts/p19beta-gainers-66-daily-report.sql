-- P19β — Daily report for "Gainers 6/6 strict operational test" (Issue #128).
--
-- USAGE
--   psql "$SUPABASE_DB_URL" -v portfolio_id="'<UUID>'" -f p19beta-gainers-66-daily-report.sql
--
-- Or in Supabase SQL Editor : remplace :portfolio_id par '<UUID>' dans la
-- variable au début, puis run.
--
-- Couvre 14 jours rolling. Sections :
--   1. Daily counts (gainer_opened, closed_target, closed_stop, shadow_566/466)
--   2. Expectancy comparée 6/6 réel vs shadow 5/6 vs shadow 4/6 (proxy : si
--      les shadow trades avaient été ouverts à `payload->>'price'` avec
--      même TP/SL, qu'auraient-ils donné en théorie ? Sur l'historique réel
--      on ne peut le savoir qu'a posteriori — proxy = TP_HIT vs SL_HIT au
--      ratio observé sur les vrais 6/6 de la période).
--   3. Fees aggregate (total/jour) sur les vrais opens 6/6.
--   4. Decision GO/PIVOT/KILL helper (n_trades, hit_rate, expectancy_$, fees%).
--
-- INVARIANTS DB (cf. CLAUDE.md + migrations 0086/0090) :
--   lisa_positions.status ∈ {'open','closed_target','closed_stop','closed_invalidated','closed_manual'}
--   lisa_positions.entry_meta JSONB → contient strategy='top_gainers_v1'
--   lisa_decision_log.kind ∈ {'gainer_shadow_566','gainer_shadow_466','gainers_expectancy_negative_watchdog',...}
--
-- ─────────────────────────────────────────────────────────────────────────────

\set portfolio_id '''11111111-1111-1111-1111-111111111111'''

\timing on

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Daily counts (last 14d)
-- ─────────────────────────────────────────────────────────────────────────────
WITH days AS (
  SELECT generate_series(
    CURRENT_DATE - INTERVAL '13 days',
    CURRENT_DATE,
    INTERVAL '1 day'
  )::date AS day
),
opens AS (
  SELECT
    DATE(entry_timestamp) AS day,
    COUNT(*) AS gainer_opened
  FROM public.lisa_positions
  WHERE portfolio_id = :portfolio_id
    AND entry_meta->>'strategy' = 'top_gainers_v1'
    AND entry_timestamp >= CURRENT_DATE - INTERVAL '14 days'
  GROUP BY 1
),
closes AS (
  SELECT
    DATE(exit_timestamp) AS day,
    SUM(CASE WHEN status = 'closed_target' THEN 1 ELSE 0 END) AS closed_target,
    SUM(CASE WHEN status = 'closed_stop'   THEN 1 ELSE 0 END) AS closed_stop,
    SUM(CASE WHEN status = 'closed_invalidated' THEN 1 ELSE 0 END) AS closed_invalidated,
    SUM(CASE WHEN status = 'closed_manual' THEN 1 ELSE 0 END) AS closed_manual
  FROM public.lisa_positions
  WHERE portfolio_id = :portfolio_id
    AND entry_meta->>'strategy' = 'top_gainers_v1'
    AND status LIKE 'closed_%'
    AND exit_timestamp >= CURRENT_DATE - INTERVAL '14 days'
  GROUP BY 1
),
shadows AS (
  SELECT
    DATE(created_at) AS day,
    SUM(CASE WHEN kind = 'gainer_shadow_566' THEN 1 ELSE 0 END) AS shadow_566,
    SUM(CASE WHEN kind = 'gainer_shadow_466' THEN 1 ELSE 0 END) AS shadow_466
  FROM public.lisa_decision_log
  WHERE portfolio_id = :portfolio_id
    AND kind IN ('gainer_shadow_566', 'gainer_shadow_466')
    AND created_at >= CURRENT_DATE - INTERVAL '14 days'
  GROUP BY 1
)
SELECT
  d.day,
  COALESCE(o.gainer_opened, 0)      AS gainer_opened,
  COALESCE(c.closed_target, 0)      AS closed_target,
  COALESCE(c.closed_stop, 0)        AS closed_stop,
  COALESCE(c.closed_invalidated, 0) AS closed_invalidated,
  COALESCE(c.closed_manual, 0)      AS closed_manual,
  COALESCE(s.shadow_566, 0)         AS shadow_566,
  COALESCE(s.shadow_466, 0)         AS shadow_466
FROM days d
LEFT JOIN opens   o ON o.day = d.day
LEFT JOIN closes  c ON c.day = d.day
LEFT JOIN shadows s ON s.day = d.day
ORDER BY d.day DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Expectancy comparée 6/6 réel vs shadow 5/6 vs shadow 4/6
--
-- Hypothèse simulation : les shadow trades auraient touché TP/SL au même ratio
-- (hit_rate) que les vrais 6/6 de la fenêtre, avec même TP%/SL%. C'est un
-- proxy pour pré-décision J+14 — pas un backtest exact (faudrait re-fetch
-- intraday data depuis EODHD).
-- ─────────────────────────────────────────────────────────────────────────────
WITH real_trades AS (
  SELECT
    realized_pnl_usd::numeric AS pnl,
    CASE WHEN realized_pnl_usd::numeric > 0 THEN 1 ELSE 0 END AS is_win,
    CASE WHEN realized_pnl_usd::numeric < 0 THEN 1 ELSE 0 END AS is_loss
  FROM public.lisa_positions
  WHERE portfolio_id = :portfolio_id
    AND entry_meta->>'strategy' = 'top_gainers_v1'
    AND status LIKE 'closed_%'
    AND realized_pnl_usd IS NOT NULL
    AND exit_timestamp >= CURRENT_DATE - INTERVAL '14 days'
),
real_stats AS (
  SELECT
    COUNT(*)                                    AS n_trades,
    SUM(is_win)                                 AS wins,
    SUM(is_loss)                                AS losses,
    NULLIF(SUM(is_win), 0)                      AS wins_nz,
    NULLIF(SUM(is_loss), 0)                     AS losses_nz,
    AVG(CASE WHEN is_win = 1 THEN pnl END)      AS avg_win_usd,
    AVG(CASE WHEN is_loss = 1 THEN pnl END)     AS avg_loss_usd,
    SUM(pnl)                                    AS total_pnl_usd,
    AVG(pnl)                                    AS avg_pnl_usd
  FROM real_trades
),
shadow_counts AS (
  SELECT
    SUM(CASE WHEN kind = 'gainer_shadow_566' THEN 1 ELSE 0 END) AS shadow_566_count,
    SUM(CASE WHEN kind = 'gainer_shadow_466' THEN 1 ELSE 0 END) AS shadow_466_count
  FROM public.lisa_decision_log
  WHERE portfolio_id = :portfolio_id
    AND kind IN ('gainer_shadow_566', 'gainer_shadow_466')
    AND created_at >= CURRENT_DATE - INTERVAL '14 days'
)
SELECT
  '6/6 réel'                                                    AS bucket,
  rs.n_trades                                                   AS n,
  ROUND(100.0 * rs.wins  / NULLIF(rs.n_trades, 0), 1)           AS hit_rate_pct,
  ROUND(rs.avg_win_usd::numeric, 2)                             AS avg_win_usd,
  ROUND(rs.avg_loss_usd::numeric, 2)                            AS avg_loss_usd,
  ROUND(
    (
      COALESCE(rs.wins, 0)::numeric / NULLIF(rs.n_trades, 0)
      * COALESCE(rs.avg_win_usd, 0)::numeric
    )
    -
    (
      COALESCE(rs.losses, 0)::numeric / NULLIF(rs.n_trades, 0)
      * ABS(COALESCE(rs.avg_loss_usd, 0))::numeric
    ),
    2
  )                                                             AS expectancy_per_trade_usd,
  ROUND(rs.total_pnl_usd::numeric, 2)                           AS total_pnl_usd
FROM real_stats rs
UNION ALL
SELECT
  '5/6 shadow (proxy)'                                          AS bucket,
  sc.shadow_566_count                                           AS n,
  ROUND(100.0 * COALESCE(rs.wins, 0)::numeric / NULLIF(rs.n_trades, 0), 1)  AS hit_rate_pct,
  ROUND(rs.avg_win_usd::numeric, 2)                             AS avg_win_usd,
  ROUND(rs.avg_loss_usd::numeric, 2)                            AS avg_loss_usd,
  ROUND(
    sc.shadow_566_count *
    (
      (COALESCE(rs.wins, 0)::numeric / NULLIF(rs.n_trades, 0)
       * COALESCE(rs.avg_win_usd, 0)::numeric)
      -
      (COALESCE(rs.losses, 0)::numeric / NULLIF(rs.n_trades, 0)
       * ABS(COALESCE(rs.avg_loss_usd, 0))::numeric)
    ),
    2
  )                                                             AS expectancy_per_trade_usd,
  NULL                                                          AS total_pnl_usd
FROM real_stats rs CROSS JOIN shadow_counts sc
UNION ALL
SELECT
  '4/6 shadow (proxy)'                                          AS bucket,
  sc.shadow_466_count                                           AS n,
  ROUND(100.0 * COALESCE(rs.wins, 0)::numeric / NULLIF(rs.n_trades, 0), 1)  AS hit_rate_pct,
  ROUND(rs.avg_win_usd::numeric, 2)                             AS avg_win_usd,
  ROUND(rs.avg_loss_usd::numeric, 2)                            AS avg_loss_usd,
  ROUND(
    sc.shadow_466_count *
    (
      (COALESCE(rs.wins, 0)::numeric / NULLIF(rs.n_trades, 0)
       * COALESCE(rs.avg_win_usd, 0)::numeric)
      -
      (COALESCE(rs.losses, 0)::numeric / NULLIF(rs.n_trades, 0)
       * ABS(COALESCE(rs.avg_loss_usd, 0))::numeric)
    ),
    2
  )                                                             AS expectancy_per_trade_usd,
  NULL                                                          AS total_pnl_usd
FROM real_stats rs CROSS JOIN shadow_counts sc;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Fees aggregate par jour (vrais opens 6/6 uniquement)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT
  DATE(exit_timestamp) AS day,
  COUNT(*) AS n_trades,
  ROUND(SUM(COALESCE((entry_meta->'fees'->>'total')::numeric, 0))::numeric, 2)
                       AS fees_open_usd,
  ROUND(SUM(COALESCE((exit_meta->'fees'->>'total')::numeric, 0))::numeric, 2)
                       AS fees_close_usd,
  ROUND(
    SUM(
      COALESCE((entry_meta->'fees'->>'total')::numeric, 0)
      + COALESCE((exit_meta->'fees'->>'total')::numeric, 0)
    )::numeric,
    2
  )                    AS fees_total_usd,
  ROUND(SUM(realized_pnl_usd::numeric)::numeric, 2)
                       AS pnl_total_usd,
  -- Ratio fees/gains (les pertes comptent en absolu pour le dénominateur).
  CASE WHEN SUM(GREATEST(realized_pnl_usd::numeric, 0)) > 0 THEN
    ROUND(
      100.0
      * SUM(
          COALESCE((entry_meta->'fees'->>'total')::numeric, 0)
          + COALESCE((exit_meta->'fees'->>'total')::numeric, 0)
        )::numeric
      / SUM(GREATEST(realized_pnl_usd::numeric, 0))::numeric,
      1
    )
    ELSE NULL
  END                  AS fees_pct_of_gross_wins
FROM public.lisa_positions
WHERE portfolio_id = :portfolio_id
  AND entry_meta->>'strategy' = 'top_gainers_v1'
  AND status LIKE 'closed_%'
  AND exit_timestamp >= CURRENT_DATE - INTERVAL '14 days'
GROUP BY 1
ORDER BY 1 DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Decision helper J+14 : GO / PIVOT / KILL
--
-- Heuristique (cf. Issue #128 phase 6) :
--   GO     : n >= 30  AND  hit_rate >= 55%  AND  expectancy_per_trade > 0
--                   AND  fees_pct_of_gross_wins <= 30%
--   KILL   : n >= 30  AND  expectancy_per_trade <= 0
--   PIVOT  : tout le reste (sample insuffisant, ou marginal positif/négatif)
-- ─────────────────────────────────────────────────────────────────────────────
WITH stats AS (
  SELECT
    COUNT(*)                                   AS n,
    SUM(CASE WHEN realized_pnl_usd::numeric > 0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN realized_pnl_usd::numeric < 0 THEN 1 ELSE 0 END) AS losses,
    AVG(CASE WHEN realized_pnl_usd::numeric > 0 THEN realized_pnl_usd::numeric END)  AS avg_win,
    AVG(CASE WHEN realized_pnl_usd::numeric < 0 THEN realized_pnl_usd::numeric END)  AS avg_loss,
    SUM(realized_pnl_usd::numeric)             AS total_pnl,
    SUM(
      COALESCE((entry_meta->'fees'->>'total')::numeric, 0)
      + COALESCE((exit_meta->'fees'->>'total')::numeric, 0)
    )                                          AS fees_total,
    SUM(GREATEST(realized_pnl_usd::numeric, 0)) AS gross_wins
  FROM public.lisa_positions
  WHERE portfolio_id = :portfolio_id
    AND entry_meta->>'strategy' = 'top_gainers_v1'
    AND status LIKE 'closed_%'
    AND exit_timestamp >= CURRENT_DATE - INTERVAL '14 days'
)
SELECT
  n,
  wins,
  losses,
  ROUND(100.0 * wins::numeric / NULLIF(n, 0), 1)  AS hit_rate_pct,
  ROUND(avg_win::numeric, 2)                       AS avg_win_usd,
  ROUND(avg_loss::numeric, 2)                      AS avg_loss_usd,
  ROUND(
    (wins::numeric / NULLIF(n, 0)) * COALESCE(avg_win, 0)::numeric
    - (losses::numeric / NULLIF(n, 0)) * ABS(COALESCE(avg_loss, 0))::numeric,
    2
  )                                                AS expectancy_per_trade_usd,
  ROUND(total_pnl::numeric, 2)                     AS total_pnl_usd,
  ROUND(fees_total::numeric, 2)                    AS fees_total_usd,
  ROUND(100.0 * fees_total::numeric / NULLIF(gross_wins, 0)::numeric, 1) AS fees_pct_of_gross_wins,
  CASE
    WHEN n < 30 THEN 'PIVOT (sample insuffisant, n<30)'
    WHEN (wins::numeric / NULLIF(n, 0)) * COALESCE(avg_win, 0)::numeric
         - (losses::numeric / NULLIF(n, 0)) * ABS(COALESCE(avg_loss, 0))::numeric <= 0
      THEN 'KILL (expectancy ≤ 0)'
    WHEN 100.0 * wins::numeric / NULLIF(n, 0) >= 55
      AND (wins::numeric / NULLIF(n, 0)) * COALESCE(avg_win, 0)::numeric
          - (losses::numeric / NULLIF(n, 0)) * ABS(COALESCE(avg_loss, 0))::numeric > 0
      AND 100.0 * fees_total::numeric / NULLIF(gross_wins, 0)::numeric <= 30
      THEN 'GO (hit≥55%, exp>0, fees≤30% gross_wins)'
    ELSE 'PIVOT (marginal — review)'
  END                                              AS decision
FROM stats;
