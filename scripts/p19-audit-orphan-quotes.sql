-- P19 — Audit / cleanup orphan quotes (defensive — not expected to find any
-- thanks to FK ON DELETE CASCADE on `quotes.asset_id`, but safety check is
-- cheap to run after the fix lands).
--
-- USAGE
--   1. Connect to the Supabase DB (or local pg via supabase db connect)
--   2. Run section 1 first (LIMIT 100, fast) to confirm volume.
--   3. If section 1 returns 0 rows → no orphans, you're done.
--   4. If section 1 returns > 0 rows → investigate WHY (FK should prevent
--      INSERT; orphans should not exist post-fix). Run section 2 for full
--      scan, then section 3 for cleanup.
--
-- BACKGROUND
--   Issue #84 (P19) — `MarketDataScheduler.refreshQuotes` was failing with
--   FK violation `quotes_asset_id_fkey`. Root cause was application-side :
--   `getOpenPositionAssets` used `lisa_positions.id` as the `assetId` in
--   the ProviderAsset, which is NOT a valid FK to `assets.id`. The fix
--   in `MarketDataService.ensureAssetRow` upserts a real `assets` row
--   before any quote insert, eliminating the FK violation at source.
--
-- The FK already has `ON DELETE CASCADE` (migration 0002), so deleting
-- an asset auto-deletes its quotes — no orphans should ever exist.

\timing on

-- ── Section 1 — Quick scan (LIMIT 100) ─────────────────────────────────────

\echo '== Section 1 — Quick scan for orphan quotes (LIMIT 100) =='
SELECT
  q.asset_id,
  COUNT(*)              AS orphan_count,
  MIN(q.as_of)          AS oldest_orphan,
  MAX(q.as_of)          AS newest_orphan
FROM public.quotes q
LEFT JOIN public.assets a ON a.id = q.asset_id
WHERE a.id IS NULL
GROUP BY q.asset_id
ORDER BY orphan_count DESC
LIMIT 100;

-- ── Section 2 — Full scan (run only if Section 1 returns rows) ─────────────

\echo '== Section 2 — Total orphan count (full scan) =='
-- Uncomment only after seeing Section 1 results.
-- SELECT COUNT(*) AS total_orphan_quotes
-- FROM public.quotes q
-- LEFT JOIN public.assets a ON a.id = q.asset_id
-- WHERE a.id IS NULL;

-- ── Section 3 — Cleanup (run only if you accept the loss of orphan rows) ───

\echo '== Section 3 — Cleanup (commented out, uncomment to apply) =='
-- BEGIN;
--   DELETE FROM public.quotes
--   WHERE asset_id IN (
--     SELECT q.asset_id
--     FROM public.quotes q
--     LEFT JOIN public.assets a ON a.id = q.asset_id
--     WHERE a.id IS NULL
--   );
-- COMMIT;

-- ── Section 4 — Sanity check on FK constraint ─────────────────────────────

\echo '== Section 4 — Verify FK ON DELETE CASCADE is in place =='
SELECT
  tc.constraint_name,
  tc.table_name,
  kcu.column_name,
  rc.delete_rule
FROM information_schema.referential_constraints rc
JOIN information_schema.table_constraints tc
  ON tc.constraint_name = rc.constraint_name
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = rc.constraint_name
WHERE tc.table_name = 'quotes'
  AND tc.constraint_type = 'FOREIGN KEY';
-- Expected : delete_rule = 'CASCADE' on quotes_asset_id_fkey
