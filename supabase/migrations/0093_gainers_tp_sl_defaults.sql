-- P19x.2 (29/04/2026) — TP/SL configurables par portfolio pour le scanner Gainers.
--
-- Bug constaté : `top-gainers-scanner.service.ts:858-859` utilisait des
-- valeurs hardcoded `stopLossPct: 1.5` + `takeProfitPct: 3.0`. Le user
-- a observé 10 trades fermés "TP hit" tous en perte (post-fees), preuve
-- que le couple TP/SL n'était pas adapté aux fees IBKR + à la volatilité
-- intraday des micro-moves.
--
-- Spec user (29/04 02:00 UTC) :
--   TP = 1.5% (lock in profits plus tôt, vs 3.0% qui rate les retracements)
--   SL = 1.0% (vs 1.5%, stop plus serré pour limiter drawdown par trade)
--
-- Cette migration ajoute 2 colonnes configurables par portfolio. Le scanner
-- lit ces valeurs avec fallback aux nouveaux defaults (1.5 / 1.0).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_default_tp_pct numeric(4, 2) NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS gainers_default_sl_pct numeric(4, 2) NOT NULL DEFAULT 1.0;

-- Garde-fous : TP > 0 (gain), SL > 0 (drawdown limite, exprimé en absolu).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_tp_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_tp_check
      CHECK (gainers_default_tp_pct > 0 AND gainers_default_tp_pct <= 50);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_sl_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_sl_check
      CHECK (gainers_default_sl_pct > 0 AND gainers_default_sl_pct <= 20);
  END IF;
END $$;

COMMENT ON COLUMN public.lisa_session_configs.gainers_default_tp_pct IS
  'Take-profit default % pour positions ouvertes par TopGainersScannerService. '
  'P19x.2 (29/04/2026) : default 1.5% (vs 3.0% pré-P19x.2). Sert de fallback '
  'quand expression.takeProfitPct n''est pas fournie.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_default_sl_pct IS
  'Stop-loss default % pour positions ouvertes par TopGainersScannerService. '
  'P19x.2 (29/04/2026) : default 1.0% (vs 1.5% pré-P19x.2).';
