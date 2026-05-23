-- 0157_backfill_paper_trades_close_mirror.sql
--
-- Backfill rétroactif des paper_trades restées à status='open' alors que
-- leur lisa_positions miroir (via scanner_position_id) est fermée.
--
-- Contexte : la table paper_trades audit P8/P9 est alimentée à l'INSERT par
-- le scanner (top-gainers-scanner.service.ts:3674) mais aucun UPDATE n'a
-- jamais été câblé au close. Résultat : 564 paper_trades historiques toutes
-- à status='open' alors que la position miroir est fermée depuis longtemps.
-- → P9 logistic regression `insufficient_sample` perpétuel.
--
-- La PR qui accompagne ce backfill (paper-broker.service.ts) corrige le
-- problème pour les futurs closes. Cette migration nettoie l'historique.
--
-- Idempotente : ne touche que les rows où status='open' ET la position
-- miroir est fermée (filtré par status != 'open' côté lisa_positions).
-- Re-exécution silencieuse = no-op.

-- Note : paper_trades.status est sous CHECK ('open', 'closed', 'cancelled')
-- alors que lisa_positions.status a une granularité plus fine
-- ('closed_target', 'closed_stop', 'closed_invalidated', etc). On simplifie
-- à 'closed' pour respecter le CHECK ; le détail précis reste dans
-- lisa_positions (joint via scanner_position_id si besoin).

UPDATE public.paper_trades pt
SET
  status = 'closed',
  closed_at = lp.exit_timestamp,
  exit_price = lp.exit_price,
  pnl_usd = lp.realized_pnl_usd,
  pnl_pct = lp.realized_pnl_pct,
  hold_duration_seconds = GREATEST(
    0,
    EXTRACT(EPOCH FROM (lp.exit_timestamp - lp.entry_timestamp))::INT
  ),
  -- outcome_label SMALLINT : 1 = win (pnl > 0), 0 = loss/flat (pnl ≤ 0).
  -- Mapping aligné avec persistence-probability.service.ts:348.
  outcome_label = CASE WHEN lp.realized_pnl_pct > 0 THEN 1 ELSE 0 END,
  updated_at = NOW()
FROM public.lisa_positions lp
WHERE pt.scanner_position_id = lp.id
  AND pt.status = 'open'
  AND lp.status <> 'open'
  AND lp.exit_timestamp IS NOT NULL
  AND lp.realized_pnl_pct IS NOT NULL;
