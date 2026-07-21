-- 0204 — Trajectoire forward multi-horizon POPULATION COMPLÈTE (21/07/2026).
--
-- Contexte : le panneau « meilleur jour de sortie » lisait position_close_decisions
-- (gagnantes verrouillées uniquement) → biais de survie qui a successivement fait
-- croire à un pic J+3 (18/06) puis J+6 (22/06). Le verdict population complète
-- (30/06, reconfirmé 21/07 : lock +0.64%/+1.20% vs J+10 −4.29%/−0.84%) = le lock
-- bat tous les horizons. Pour que l'UI affiche la loi SANS biais et qu'elle se
-- mette à jour seule, le labeler stampe désormais aussi J+1/J+3/J+6 sur TOUTES
-- les entrées (comme fwd_return_10d). Backfill progressif par le cron reconcile.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS fwd_return_1d NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS fwd_return_3d NUMERIC;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS fwd_return_6d NUMERIC;

COMMENT ON COLUMN paper_trades.fwd_return_1d IS 'Rendement %% entrée→J+1 ouvré (population complète, labeler oversold)';
COMMENT ON COLUMN paper_trades.fwd_return_3d IS 'Rendement %% entrée→J+3 ouvrés (population complète, labeler oversold)';
COMMENT ON COLUMN paper_trades.fwd_return_6d IS 'Rendement %% entrée→J+6 ouvrés (population complète, labeler oversold)';
