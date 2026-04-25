-- Ajout d'une colonne conviction_score sur lisa_positions.
--
-- Avant ce fix, le choix de fermeture lors d'un dépassement de cap
-- (asset class ou expo totale) utilisait le notional comme proxy de
-- "plus basse conviction". Mais une position de $300 conviction 9/10
-- vaut probablement plus qu'une de $500 conviction 6/10 — le notional
-- seul est un mauvais proxy.
--
-- Cette colonne stocke la vraie conviction de Lisa (0-10) au moment de
-- l'ouverture, lue depuis target.convictionScore dans les directives
-- mécaniques.
--
-- Nullable pour rétrocompat des positions existantes (closing logic
-- fallback sur notional si null).

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS conviction_score numeric(3, 1) NULL;

COMMENT ON COLUMN public.lisa_positions.conviction_score IS
  'Conviction Lisa au moment de l''ouverture (0-10). Null pour positions héritées sans score explicite.';
