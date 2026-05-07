-- 0129_lisa_positions_actual_costs
--
-- Phase F — IBKR LIVE Trading. Tracking des coûts réels broker pour
-- calibration vs cost-engine théorique.
--
-- Quand une position est ouverte/fermée en mode LIVE (Phase H+), on
-- récupère les vrais fees + slippage observés via broker.getFills() et
-- on persiste dans lisa_positions. Le RealCostCalibratorService compare
-- ensuite théorique (cost-engine) vs actual (broker) sur 30j et propose
-- un ajustement des coefficients si écart > 10%.
--
-- Tant qu'aucun trade LIVE → ces colonnes restent NULL (paper trading
-- inchangé). Pas de migration des positions existantes.

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS actual_entry_fees_usd NUMERIC(28,4);

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS actual_exit_fees_usd NUMERIC(28,4);

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS actual_entry_slippage_bps INT;

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS actual_exit_slippage_bps INT;

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS broker_order_id_entry TEXT;

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS broker_order_id_exit TEXT;

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS broker_connection_id UUID REFERENCES public.broker_connections(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lisa_positions_broker_order_entry_idx
  ON public.lisa_positions(broker_order_id_entry)
  WHERE broker_order_id_entry IS NOT NULL;

CREATE INDEX IF NOT EXISTS lisa_positions_broker_order_exit_idx
  ON public.lisa_positions(broker_order_id_exit)
  WHERE broker_order_id_exit IS NOT NULL;

COMMENT ON COLUMN public.lisa_positions.actual_entry_fees_usd IS
  'Phase F LIVE — Commission RÉELLE entrée broker (vs estimation cost-engine). NULL en paper trading.';
COMMENT ON COLUMN public.lisa_positions.actual_exit_fees_usd IS
  'Phase F LIVE — Commission RÉELLE sortie broker. NULL en paper trading.';
COMMENT ON COLUMN public.lisa_positions.actual_entry_slippage_bps IS
  'Phase F LIVE — Slippage entry: (avg_fill - expected_price) / expected_price × 10000.';
COMMENT ON COLUMN public.lisa_positions.actual_exit_slippage_bps IS
  'Phase F LIVE — Slippage exit: (avg_fill - target_price) / target_price × 10000.';
COMMENT ON COLUMN public.lisa_positions.broker_order_id_entry IS
  'Phase F LIVE — IBKR/Binance order_id de l''entrée. Pour reconciliation + audit.';
COMMENT ON COLUMN public.lisa_positions.broker_order_id_exit IS
  'Phase F LIVE — IBKR/Binance order_id de la sortie.';
COMMENT ON COLUMN public.lisa_positions.broker_connection_id IS
  'Phase F LIVE — Lien vers la broker_connection utilisée. Aide au mapping multi-broker.';
