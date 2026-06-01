-- 0183_cleanup_orphan_lesson_citations.sql
--
-- Cleanup des citations orphelines (lesson_id IS NULL) accumulées avant
-- le fix PR #549 (parseLessonMarkers blacklist + skip insert si lesson_id null).
--
-- Contexte : audit 01/06/2026 du Lessons Impact Tracker :
--   287 citations sur 30j / 0 résolues / 100% "Marker non mappé à scanner_lessons"
--
-- Root cause (corrigée en PR #549) :
--   - parseLessonMarkers filtrait seulement 5 markers infra (DIAGNOSTIC, etc.)
--   - Section headers du prompt (OPEN_POSITIONS, KELLY_STANDARD, PUMP_SCORE,
--     DATA_QUALITY_DEGRADED, ANTI-PATTERN, AUTO_CORRECTION_DYNAMIQUE...) passaient
--   - insertLessonCitations matchait ILIKE '%marker%' (loose) puis insérait
--     même sans lesson_id → 287 rows polluants
--
-- Cette migration nettoie l'existant pour que le tracker affiche désormais
-- seulement les vraies lessons mappées à scanner_lessons.
--
-- Idempotent : DELETE WHERE lesson_id IS NULL → 0 rows si déjà appliquée
-- (PR #549 garantit qu'aucune nouvelle ligne avec lesson_id=null ne sera créée).

DELETE FROM scanner_lesson_citations
WHERE lesson_id IS NULL;
