-- 0203 — Trajectoire progressive J+1/J+3/J+6/J+10 des décisions de close (oversold).
--
-- 0197 a posé le contrefactuel J+10 (price_j1/3/5/10 + deadline_verdict), rempli
-- d'un seul coup à l'échéance J+10. Demande user 10/06 : voir des verdicts
-- INTERMÉDIAIRES (J+3, J+6) qui se peuplent au fil de l'eau, + un indicateur
-- « meilleur jour » (le J+N où tenir aurait le mieux payé).
--
-- On ajoute donc :
--   - price_j6 (le checkpoint J+6 manquant ; J+1/3/10 existent déjà, J+5 conservé)
--   - trajectory JSONB : [{ "d": 1, "pnl": 0.8 }, { "d": 3, "pnl": 2.1 }, …] —
--     P&L-si-tenu à chaque checkpoint ÉCOULÉ (rempli progressivement, pas à J+10)
--   - best_day_label / best_day_pnl_pct : le meilleur checkpoint observé (badge UI)
--   - trajectory_labeled_at : marqueur du dernier passage du labeler progressif
--     (distinct de deadline_labeled_at qui ne se pose qu'à la finalisation J+10)
ALTER TABLE position_close_decisions
  ADD COLUMN IF NOT EXISTS price_j6 NUMERIC,
  ADD COLUMN IF NOT EXISTS trajectory JSONB,            -- [{ d:int, pnl:number }] checkpoints écoulés
  ADD COLUMN IF NOT EXISTS best_day_label TEXT,         -- 'J+6'
  ADD COLUMN IF NOT EXISTS best_day_pnl_pct NUMERIC,    -- P&L-si-tenu au meilleur jour
  ADD COLUMN IF NOT EXISTS trajectory_labeled_at TIMESTAMPTZ;

-- Reload PostgREST schema cache (sinon l'API ne voit pas les colonnes immédiatement)
NOTIFY pgrst, 'reload schema';
