-- Migration 0163 — Make try_open_position same-symbol guard direction-aware.
--
-- Root cause: Migration 0162 added a v_symbol_exists guard that blocks ANY
-- second open for (portfolio_id, symbol) WHERE status='open', regardless of
-- direction. This unintentionally breaks REVERSE_MOMENTUM_MODE=both (Miracle #1
-- feature), which deliberately opens BOTH a LONG and a SHORT on the same
-- top-gainer symbol. Since 2026-05-25 06:57 UTC (when 0162 was applied), the
-- second leg of mode=both pairs has been rejected with POSITION_CAP_REACHED,
-- causing openTopGainerPosition to return null after the first leg.
--
-- Fix: add `AND direction = p_payload->>'direction'` to the v_symbol_exists
-- check. This keeps the original safety net (no two concurrent scanner
-- instances opening the same (portfolio_id, symbol, direction) pair) while
-- allowing intentional LONG+SHORT pairs from reverse momentum mode.
--
-- Note on the UNIQUE INDEX from 0162: idx_lisa_positions_unique_open_symbol
-- is still on (portfolio_id, symbol) WHERE status='open'. We must DROP it and
-- recreate it with `direction` in the key to be consistent with the function
-- guard — otherwise the DB-level safety net rejects mode=both pairs from the
-- legacy INSERT path (when openPositionDirect is called without
-- maxOpenPositions, bypassing the RPC).

DROP INDEX IF EXISTS idx_lisa_positions_unique_open_symbol;

CREATE UNIQUE INDEX IF NOT EXISTS idx_lisa_positions_unique_open_symbol_direction
  ON lisa_positions (portfolio_id, symbol, direction)
  WHERE status = 'open';

-- Update try_open_position to be direction-aware.
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

  -- Guard same-symbol + same-direction duplicate (concurrent scanner instances).
  -- Cross-direction pairs (LONG + SHORT) allowed for REVERSE_MOMENTUM_MODE=both.
  SELECT COUNT(*) INTO v_symbol_exists
    FROM lisa_positions
   WHERE portfolio_id = p_portfolio_id
     AND status = 'open'
     AND symbol = p_payload->>'symbol'
     AND direction = p_payload->>'direction';

  IF v_symbol_exists > 0 THEN
    RETURN NULL;  -- symbole+direction déjà ouvert: skip silencieux
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
  'Bug #314 #M3 — Ouverture atomique de position avec garde de cap + garde same-symbol+same-direction (migration 0163). Verrou advisory xact scopé portfolio_id. Retourne id de la position créée, NULL si cap atteint ou si (symbol, direction) déjà ouvert. Cross-direction (LONG+SHORT) autorisé pour REVERSE_MOMENTUM_MODE=both.';
