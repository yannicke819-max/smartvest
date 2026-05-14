-- Bug #314 #M3 — Race condition scanner gainers vs autopilot → over-cap positions.
--
-- Les crons `top-gainers-scanner` et `lisa-autopilot` (via approveProposal)
-- tournent tous deux à la minute, sans verrou DB sur `lisa_positions`. Scénario :
--   T0    : scanner lit 4/5 positions ouvertes, calcule slots=1
--   T0+ε  : autopilot lit 4/5 positions ouvertes, calcule slots=1
--   T0+δ1 : scanner INSERT → 5/5
--   T0+δ2 : autopilot INSERT → 6/5  ← cap dépassé, sur-exposition
--
-- Fix : ouverture atomique check+insert dans une seule fonction DB-side.
--
-- Choix du verrou — `pg_advisory_xact_lock(hashtext(portfolio_id))` plutôt que
-- `SELECT COUNT(*) ... FOR UPDATE` :
--   * `FOR UPDATE` est INVALIDE en Postgres avec une fonction d'agrégat
--     (`ERROR: FOR UPDATE is not allowed with aggregate functions`) — l'esquisse
--     initiale de l'issue #314 ne compilait pas.
--   * `pg_advisory_xact_lock` est un verrou applicatif scopé sur la clé
--     `hashtext(portfolio_id)` : deux appels concurrents sur le MÊME portfolio
--     sérialisent proprement ; des portfolios différents ne se bloquent jamais.
--   * Variante `xact` : le verrou est libéré AUTOMATIQUEMENT à la fin de la
--     transaction (= fin de l'appel RPC Supabase) — pas de fuite de lock même
--     si la fonction throw.
--
-- Résiste au scaling horizontal Fly : `fly.toml` a `auto_start_machines = true`,
-- une 2e machine sous charge relancerait les crons → la DB reste seule source
-- de vérité atomique, contrairement à un mutex applicatif en mémoire.

CREATE OR REPLACE FUNCTION try_open_position(
  p_portfolio_id uuid,
  p_max_open int,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_open_count int;
  v_pos_id uuid;
BEGIN
  -- Verrou applicatif scopé portfolio. Libéré auto en fin de transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_portfolio_id::text));

  SELECT COUNT(*) INTO v_open_count
    FROM lisa_positions
   WHERE portfolio_id = p_portfolio_id
     AND status = 'open';

  IF v_open_count >= p_max_open THEN
    RETURN NULL;  -- cap déjà atteint : aucun INSERT, le caller log + skip
  END IF;

  -- jsonb_populate_record gère le typage (il connaît les types de colonnes de
  -- lisa_positions). La liste explicite de colonnes en INSERT (...) SELECT (...)
  -- restreint l'insertion aux 21 colonnes fournies par openPositionDirect →
  -- toutes les autres colonnes prennent leur DEFAULT (pas de NULL forcé).
  INSERT INTO lisa_positions (
    id, portfolio_id, proposal_id, thesis_id, symbol, asset_class,
    direction, venue, quantity, entry_price, entry_timestamp,
    entry_notional_usd, status, stop_loss_price, take_profit_price,
    horizon_target_date, estimated_entry_cost_usd, fees_in_usd,
    venue_fee_detail, created_at, updated_at
  )
  SELECT
    id, portfolio_id, proposal_id, thesis_id, symbol, asset_class,
    direction, venue, quantity, entry_price, entry_timestamp,
    entry_notional_usd, status, stop_loss_price, take_profit_price,
    horizon_target_date, estimated_entry_cost_usd, fees_in_usd,
    venue_fee_detail, created_at, updated_at
  FROM jsonb_populate_record(NULL::lisa_positions, p_payload)
  RETURNING id INTO v_pos_id;

  RETURN v_pos_id;
END;
$$;

COMMENT ON FUNCTION try_open_position(uuid, int, jsonb) IS
  'Bug #314 #M3 — Ouverture atomique de position avec garde de cap. Verrou advisory xact scopé portfolio_id. Retourne l''id de la position créée, ou NULL si le cap p_max_open est déjà atteint (caller doit log + skip).';
