-- Migration 0162 — Prevent same-symbol duplicate open positions.
--
-- Root cause: two concurrent scanner instances (Fly.io horizontal scaling) both
-- read openSymbols=[] before either insert completes, then race to open the
-- same winner ticker. try_open_position serializes via advisory lock and guards
-- maxOpenPositions, but did NOT guard against same-symbol duplicates (only
-- checked count). Result: doubled exposure on the same ticker.
--
-- Fix 1 — Partial UNIQUE index (DB-level safety net, catches any path):
--   A second INSERT for (portfolio_id, symbol) WHERE status='open' raises
--   unique_violation (23505), which propagates from the RPC as rpcErr and
--   is caught + logged by the scanner as position_open_failed.
--
-- Fix 2 — Explicit check inside try_open_position (returns NULL = clean skip
--   instead of an exception, consistent with the cap-reached behaviour):
--   Before INSERT, check whether the symbol is already open; if so return NULL.

-- CONCURRENTLY omitted: migration runner wraps SQL in a transaction block,
-- and CREATE INDEX CONCURRENTLY cannot run inside a transaction (error 25001).
CREATE UNIQUE INDEX IF NOT EXISTS idx_lisa_positions_unique_open_symbol
  ON lisa_positions (portfolio_id, symbol)
  WHERE status = 'open';

-- Update try_open_position to also check for same-symbol duplicate.
CREATE OR REPLACE FUNCTION try_open_position(
  p_portfolio_id uuid,
  p_max_open int,
  p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_open_count int;
  v_symbol_exists int;
  v_pos_id uuid;
BEGIN
  -- Verrou applicatif scopé portfolio. Libéré auto en fin de transaction.
  PERFORM pg_advisory_xact_lock(hashtext(p_portfolio_id::text));

  SELECT COUNT(*) INTO v_open_count
    FROM lisa_positions
   WHERE portfolio_id = p_portfolio_id
     AND status = 'open';

  IF v_open_count >= p_max_open THEN
    RETURN NULL;  -- cap atteint
  END IF;

  -- Guard same-symbol duplicate (concurrent scanner instances).
  SELECT COUNT(*) INTO v_symbol_exists
    FROM lisa_positions
   WHERE portfolio_id = p_portfolio_id
     AND status = 'open'
     AND symbol = p_payload->>'symbol';

  IF v_symbol_exists > 0 THEN
    RETURN NULL;  -- symbol already open: skip silently, caller logs POSITION_CAP_REACHED
  END IF;

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
  'Bug #314 #M3 — Ouverture atomique de position avec garde de cap + garde same-symbol. Verrou advisory xact scopé portfolio_id. Retourne l''id de la position créée, NULL si cap atteint ou symbole déjà ouvert (migration 0162).';
