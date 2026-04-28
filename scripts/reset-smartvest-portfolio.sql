-- Reset SmartVest portfolio simulé pour repartir propre après P3-D + P4-A + P4-B.
--
-- Usage : à exécuter MANUELLEMENT une fois les 3 PR (P3-D #48, P4-A #49,
-- P4-B #50) déployées sur Fly. Toutes les migrations 0080/0081/0082
-- doivent être appliquées AVANT ce reset.
--
-- Mapping spec ticket → tables réelles :
--   `positions`             → `lisa_positions` (table existante 0043)
--   `daily_harvest_state`   → `daily_trading_sessions` (0066) +
--                              `secured_profit_balance` (0067)
--   `portfolios`            → `portfolios` (0001)
--   `lisa_decision_log`     → `lisa_decision_log` (0043)
--   `rebound_positions`     → `rebound_positions` (0076)
--
-- Vérification pré-reset : SELECT count(*) FROM lisa_positions
--   WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

BEGIN;

-- 1) Fermer toutes positions Lisa ouvertes (mark as 'reset_clean_slate')
UPDATE public.lisa_positions
SET
  status = 'closed_user',
  exit_timestamp = NOW(),
  realized_pnl_usd = '0'
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2'
  AND status = 'open';

-- 2) Reset cash + valeur du portfolio.
-- Note : la table portfolios n'a PAS de colonnes cash_usd / total_value_usd
-- (ces métriques sont dérivées de paperBroker.computeSnapshot via
-- lisa_portfolio_snapshots). Ce qu'on reset ici c'est le LATEST snapshot.
INSERT INTO public.lisa_portfolio_snapshots (
  portfolio_id, timestamp, cash_usd, open_positions_value_usd,
  total_value_usd, realized_pnl_cumulative_usd, unrealized_pnl_usd,
  return_from_inception_pct, open_positions_count, drawdown_from_peak_pct
)
VALUES (
  '58439d86-3f20-4a60-82a4-307f3f252bc2',
  NOW(),
  '10000.00', '0.00', '10000.00', '0.00', '0.00', 0, 0, 0
);

-- 3) Purger sessions Daily Harvest (= équivalent de daily_harvest_state spec).
DELETE FROM public.daily_trading_sessions
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

-- 4) Reset secured_profit_balance (vault Daily Harvest).
DELETE FROM public.secured_profit_balance
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

-- 5) Reset rebound_positions (P3-A).
DELETE FROM public.rebound_positions
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

-- 6) Reset directives mécaniques + cycle summaries.
DELETE FROM public.lisa_mechanical_directives
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

DELETE FROM public.lisa_mechanical_cycle_summary
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

-- 7) Lever kill_switch_active si actif.
UPDATE public.lisa_session_configs
SET kill_switch_active = false
WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2';

-- 8) Garder lisa_decision_log historique pour audit, mais ajouter marker.
-- Note : decision-log.service.ts gère normalement le hash chain. Insertion
-- manuelle ici contourne le hash → marker explicitement non-chained
-- (rationale dit pourquoi).
INSERT INTO public.lisa_decision_log (
  portfolio_id, timestamp, kind, summary, rationale, payload, triggered_by
)
VALUES (
  '58439d86-3f20-4a60-82a4-307f3f252bc2',
  NOW(),
  'portfolio_reset_clean_slate',
  'RESET post P3-D + P4-A + P4-B (manual SQL, hors hash chain)',
  'Repart 10000 USD cash, harvest mode, watchlist multi-bourses (P4-A), rebound-only routing (P4-B). Hash chain interrompu volontairement par insertion SQL manuelle — chaîner à nouveau au prochain append() service.',
  '{"target_capital_usd": 10000, "feature_flags": ["P3-D", "P4-A", "P4-B"], "reset_kind": "clean_slate"}'::jsonb,
  'user_manual'
);

COMMIT;

-- Vérification post-reset (à exécuter dans une transaction séparée) :
-- SELECT
--   (SELECT count(*) FROM lisa_positions WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2' AND status = 'open') AS open_positions,
--   (SELECT count(*) FROM rebound_positions WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2' AND status = 'OPEN') AS open_rebounds,
--   (SELECT count(*) FROM daily_trading_sessions WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2') AS sessions,
--   (SELECT cash_usd FROM lisa_portfolio_snapshots WHERE portfolio_id = '58439d86-3f20-4a60-82a4-307f3f252bc2' ORDER BY timestamp DESC LIMIT 1) AS cash;
-- → expected : open_positions=0, open_rebounds=0, sessions=0, cash='10000.00'
