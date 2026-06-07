-- 0195_paper_trades_fwd_outcome.sql
-- PR-4a — Label à HORIZON FIXE (J+10) pour la boucle d'apprentissage oversold.
--
-- Le PnL réalisé (outcome_label/pnl_pct) dépend de DEUX choses : la qualité de
-- l'ENTRÉE *et* le timing de la SORTIE (manuelle / Mistral / stop). Pour
-- apprendre la qualité d'ENTRÉE proprement, il faut un label qui neutralise la
-- variance des sorties → rendement à horizon fixe (close[entry+N]/entry - 1).
--
-- Append-only, idempotent. Peuplé par OversoldScannerService.reconcileOversoldFeatures
-- une fois la position vieillie au-delà de l'horizon (N jours ouvrés écoulés).
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS fwd_return_10d NUMERIC;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS fwd_outcome_10d INTEGER;
ALTER TABLE public.paper_trades ADD COLUMN IF NOT EXISTS fwd_horizon_days INTEGER;

COMMENT ON COLUMN public.paper_trades.fwd_return_10d IS
  'Rendement % à horizon fixe = (close[entry+fwd_horizon_days]/entry_price - 1)*100. Label propre pour apprendre la qualité d''entrée, indépendant du timing de sortie réel.';
COMMENT ON COLUMN public.paper_trades.fwd_outcome_10d IS
  'Label binaire dérivé de fwd_return_10d (1 si > 0, sinon 0). Cible de la régression P(bonne entrée | features).';
COMMENT ON COLUMN public.paper_trades.fwd_horizon_days IS
  'Horizon (jours ouvrés) utilisé pour fwd_return_10d. Défaut 10 (= hold oversold cible).';
