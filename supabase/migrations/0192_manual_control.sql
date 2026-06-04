-- 0192 — Contrôle manuel par position (bouton UI "Prendre le contrôle").
--
-- Permet à l'utilisateur de figer l'auto-trader sur UNE position : le bot ne la
-- ferme plus automatiquement (SL, TP, trailing, risk-monitor, news-shock, early-
-- exit). Seule la close manuelle utilisateur (bouton Fermer) la ferme — et au
-- close, tout le contexte d'apprentissage (outcome, decision_log, rationale, PnL)
-- est conservé comme en auto, pour que Mistral/trader continue d'apprendre.
--
-- Le garde-fou est appliqué au chokepoint unique paperBroker.closePosition :
-- tout close auto sur une position manual_control=true est refusé sauf si le
-- caller passe allowManualControlled=true (uniquement la close manuelle).
--
-- Additive + idempotente. Default false = comportement inchangé pour l'existant.

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS manual_control BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.lisa_positions.manual_control IS
  '0192 — true = utilisateur a pris le contrôle 100% : aucun close auto (SL/TP/trailing/risk-monitor). Seule la close manuelle ferme. SL reste affiché comme repère non-déclencheur.';

-- Index partiel léger : retrouver rapidement les positions sous contrôle manuel
-- (UI badge + audits). Ne couvre que les rares rows true.
CREATE INDEX IF NOT EXISTS lisa_positions_manual_control_idx
  ON public.lisa_positions (portfolio_id)
  WHERE manual_control = true;
