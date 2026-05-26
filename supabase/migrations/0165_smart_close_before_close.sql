-- 0165 — Smart close before close (PR #464)
--
-- Adds a "smart pre-close window" feature: between T-smart_window_min and
-- T-force_close_offset_min before exchange close, positions whose unrealized
-- PnL >= min_profit_pct are auto-closed early to LOCK profits. Positions
-- below threshold continue holding until the existing hard force-close fires.
--
-- Default behavior preserved: gainers_smart_close_enabled defaults to false
-- (opt-in). Existing force_close logic unchanged.
--
-- Sequencing per portfolio cron tick:
--   1. runSmartCloseBeforeCloseTick (NEW, only positions with pnl >= threshold)
--   2. runForceCloseBeforeCloseTick (EXISTING, all remaining positions T-offset)

ALTER TABLE lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_smart_close_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gainers_smart_close_window_min INT
    DEFAULT 30
    CHECK (gainers_smart_close_window_min IS NULL
           OR (gainers_smart_close_window_min >= 15
               AND gainers_smart_close_window_min <= 120)),
  ADD COLUMN IF NOT EXISTS gainers_smart_close_min_profit_pct NUMERIC(5,2)
    DEFAULT 1.00
    CHECK (gainers_smart_close_min_profit_pct IS NULL
           OR (gainers_smart_close_min_profit_pct >= 0.10
               AND gainers_smart_close_min_profit_pct <= 10.00));

COMMENT ON COLUMN lisa_session_configs.gainers_smart_close_enabled IS
  'PR #464 — When true AND gainers_force_close_before_close_enabled is true, '
  'positions in profit close early (lock-profit) inside the pre-close window. '
  'Window = [T-smart_window_min, T-force_close_offset_min] before exchange close.';

COMMENT ON COLUMN lisa_session_configs.gainers_smart_close_window_min IS
  'PR #464 — Width of the pre-close smart window in minutes (15..120). '
  'Must be > gainers_force_close_offset_min for the smart window to exist. '
  'Default 30 = smart logic from T-30 to T-offset.';

COMMENT ON COLUMN lisa_session_configs.gainers_smart_close_min_profit_pct IS
  'PR #464 — Minimum unrealized PnL %% to trigger smart close (lock-profit). '
  'Range 0.10..10.00. Default 1.00 = close if position is +1%% or more.';

-- Append-only audit kind for decision_log filter UIs (no new column on log table).
-- Existing kind="position_closed" is reused with payload tag [SMART_CLOSE_LOCK_PROFIT]
-- to keep the existing schema constraint untouched.
