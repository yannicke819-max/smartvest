-- Migration 0189 — Apprentissage des décisions de fermeture (imitation + counterfactuel)
--
-- Objectif (idée user 03/06) : éduquer TRADER à partir des décisions de
-- fermeture de l'USER (et comparer vs ses propres exits mécaniques). Mais
-- l'imitation pure plafonne aux biais de l'user → on ajoute le COUNTERFACTUEL :
-- un cron +60min labellise CE QUE LE PRIX A FAIT après le close, transformant
-- "l'user a fermé ici" en "l'user a fermé ici ET c'était GOOD/EARLY/OK".
--
-- TRADER apprend QUAND une sortie est bonne, pas juste à copier l'humain.

CREATE TABLE IF NOT EXISTS public.position_close_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Liens
  position_id UUID NOT NULL,
  portfolio_id UUID NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT,
  asset_class TEXT,

  -- QUI a fermé (le signal d'apprentissage le plus important)
  -- user_manual / closed_choppy / closed_stop / closed_target / orphan_close / risk_monitor / other
  closer_type TEXT NOT NULL,

  -- État au close
  entry_price NUMERIC,
  exit_price NUMERIC,
  pnl_pct NUMERIC,
  pnl_usd NUMERIC,
  age_minutes NUMERIC,

  -- MFE/MAE + give-back (la règle de sortie implicite de l'user)
  mfe_pct NUMERIC,             -- meilleur favorable atteint avant close
  mae_pct NUMERIC,             -- pire adverse
  give_back_from_mfe NUMERIC,  -- mfe_pct - pnl_pct = combien rendu depuis le pic

  -- Momentum live au moment du close
  trend_5m_pct NUMERIC,        -- variation prix sur 5 min avant close
  momentum_gradient NUMERIC,
  roc5 NUMERIC,

  -- Indicateurs au close (snapshot complet pour features ML)
  rsi14 NUMERIC,
  stoch_rsi_k NUMERIC,
  macd_hist NUMERIC,
  bb_pct_b NUMERIC,
  adx14 NUMERIC,
  atr14_pct NUMERIC,

  -- Distance aux cibles (à quelle distance du TP l'user a abandonné)
  dist_to_tp_pct NUMERIC,
  dist_to_sl_pct NUMERIC,
  take_profit_price NUMERIC,
  stop_loss_price NUMERIC,

  -- Contexte marché
  vix NUMERIC,
  regime TEXT,
  session TEXT,                -- us / eu / asia / crypto
  minutes_to_market_close INT, -- évitement orphan pré-cloche ?

  -- LABEL COUNTERFACTUEL (rempli par cron +60min)
  -- price_after = prix N min après close ; verdict = qualité de la sortie
  price_after_30m NUMERIC,
  price_after_60m NUMERIC,
  max_favorable_after_60m_pct NUMERIC,  -- si on avait tenu, MFE post-close
  max_adverse_after_60m_pct NUMERIC,
  -- GOOD = bien sorti (prix a chuté / n'a pas dépassé) ; EARLY = sorti trop
  -- tôt (prix a continué vers TP) ; OK = neutre ; null = pas encore labellisé
  verdict TEXT,
  labeled_at TIMESTAMPTZ,

  -- Forward-compat
  raw_payload JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_close_decisions_portfolio
  ON public.position_close_decisions (portfolio_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_close_decisions_closer
  ON public.position_close_decisions (closer_type, closed_at DESC);
-- Pour le cron de labellisation : rows non encore labellisées + assez vieilles
CREATE INDEX IF NOT EXISTS idx_close_decisions_unlabeled
  ON public.position_close_decisions (closed_at)
  WHERE verdict IS NULL;

COMMENT ON TABLE public.position_close_decisions IS
  'Décisions de fermeture (user + mécanique) avec contexte complet + label counterfactuel (cron +60min). Éduque TRADER à QUAND sortir, par imitation supervisée vérité-terrain. Idée user 03/06.';
COMMENT ON COLUMN public.position_close_decisions.give_back_from_mfe IS
  'mfe_pct - pnl_pct : combien le prix a rendu depuis son pic au moment du close. Capture la règle de trailing implicite de l''user.';
COMMENT ON COLUMN public.position_close_decisions.verdict IS
  'GOOD = sortie justifiée (prix chute après) | EARLY = trop tôt (prix monte vers TP après) | OK = neutre | NULL = pas encore labellisé par le cron counterfactuel.';

-- RLS service_role only (table interne apprentissage)
ALTER TABLE public.position_close_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "close_decisions_service_only" ON public.position_close_decisions;
CREATE POLICY "close_decisions_service_only" ON public.position_close_decisions
  FOR ALL TO service_role USING (true) WITH CHECK (true);
