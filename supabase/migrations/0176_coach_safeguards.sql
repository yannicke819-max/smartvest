-- Migration 0176 — Coach safeguards (issue #502)
--
-- 1. Ajoute `lesson_intent` à scanner_lesson_citations pour permettre à
--    StrategyCoachService de distinguer correctement :
--    - une lesson "open" non appliquée (intent='open' AND action_applied=false)
--    - une lesson "hold/skip/exit" correctement appliquée (intent matches l'action)
--
--    Avant ce fix : le coach voyait `applied=0` sur les lessons hold-only
--    (ex: PULLBACK_WAIT_KTOS_LESSON) et concluait à tort que la lesson était
--    "non implémentée". Symptôme observé prod 30/05 : coach proposait de
--    baisser entry_threshold + activer un bot déjà actif, en contradiction
--    avec une lesson conf 0.95 née d'une perte réelle.
--
-- 2. Backfill des rows existantes depuis action_kind (idempotent).
--
-- Idempotent. À ré-exécuter sans risque.

ALTER TABLE public.scanner_lesson_citations
  ADD COLUMN IF NOT EXISTS lesson_intent text;

COMMENT ON COLUMN public.scanner_lesson_citations.lesson_intent IS
'Intent qualitatif de la lesson au moment de la citation : open / hold / skip / exit / other. Distingue une lesson "open" non appliquée d''une lesson "hold/skip" correctement appliquée. Source de vérité pour StrategyCoachService.buildContext (issue #502).';

-- Backfill : dérive depuis action_kind pour les rows existantes
UPDATE public.scanner_lesson_citations
SET lesson_intent = CASE
  WHEN action_kind IN ('open_directional', 'open_pairs', 'scale_in') THEN 'open'
  WHEN action_kind = 'hold'                                          THEN 'hold'
  WHEN action_kind LIKE 'skip%'                                      THEN 'skip'
  WHEN action_kind IN ('close', 'trail_stop')                        THEN 'exit'
  ELSE 'other'
END
WHERE lesson_intent IS NULL;

-- Index pour les agrégations coach par portfolio × intent sur fenêtre récente
CREATE INDEX IF NOT EXISTS scanner_lesson_citations_intent_idx
  ON public.scanner_lesson_citations (portfolio_id, lesson_intent, cited_at DESC)
  WHERE lesson_intent IS NOT NULL;
