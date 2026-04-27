-- 0071_themes_columns.sql
--
-- PATCH 3 (PR#3 P1) — theme tagging sur thèses Lisa et positions ouvertes.
--
-- Ajoute une colonne `themes TEXT[]` à `lisa_positions` et `lisa_proposals`.
-- Lisa tag chaque thèse avec 1-2 thèmes dominants (cf. ThemeTag enum :
-- geopolitical_safehaven, ai_megacap, energy_disruption, crypto,
-- defensive_bond_proxy, small_cap_breakout, other).
--
-- Le risk-enforcer applique un cap par thème en plus du cap par classe :
-- une thèse est rejetée si l'un des deux caps casse. Capture la
-- concentration thématique transverse aux classes d'actifs (GDX equity
-- + SLV commodity + RTX equity = 1 thème geopolitical_safehaven concentré).

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.lisa_proposals
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.lisa_positions.themes IS
  'Tags thématiques transverses (1-2 max). Cf. ThemeTag enum dans @smartvest/ai-analyst. Cap par thème géré côté risk-enforcer.';

COMMENT ON COLUMN public.lisa_proposals.themes IS
  'Tags thématiques de la proposition agrégée. Cf. ThemeTag enum dans @smartvest/ai-analyst.';

-- Index GIN pour requêtes "positions sharing this theme" (utile pour
-- monitoring concentration en /admin/monitoring)
CREATE INDEX IF NOT EXISTS lisa_positions_themes_gin
  ON public.lisa_positions USING GIN (themes);

CREATE INDEX IF NOT EXISTS lisa_proposals_themes_gin
  ON public.lisa_proposals USING GIN (themes);
