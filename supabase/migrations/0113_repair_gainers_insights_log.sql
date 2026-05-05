-- Migration 0113 — Repair Phase A gainers_insights_log (PR6.6.6 / Yaya #2).
--
-- Diagnostic : 0110 a créé la table partiellement (vraisemblablement sans
-- toutes les colonnes severity/context/resolution_*) lors d'une exécution
-- antérieure échouée. CREATE TABLE IF NOT EXISTS skip alors qu'il manque
-- des colonnes → indexes 0110 fail "column severity does not exist".
--
-- Fix : ALTER TABLE ADD COLUMN IF NOT EXISTS pour TOUTES les colonnes 0110,
-- puis re-créer les indexes manquants. Idempotente.

-- ─── Step 1 : Ajouter colonnes manquantes (si absentes) ───────────────────

ALTER TABLE public.gainers_insights_log
  ADD COLUMN IF NOT EXISTS insight_type   TEXT,
  ADD COLUMN IF NOT EXISTS source         TEXT,
  ADD COLUMN IF NOT EXISTS status         TEXT DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS severity       TEXT DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS summary        TEXT,
  ADD COLUMN IF NOT EXISTS payload        JSONB,
  ADD COLUMN IF NOT EXISTS context        JSONB,
  ADD COLUMN IF NOT EXISTS resolution     TEXT,
  ADD COLUMN IF NOT EXISTS resolution_pr  TEXT,
  ADD COLUMN IF NOT EXISTS resolved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by    TEXT;

-- ─── Step 2 : NOT NULL constraints (sur colonnes critiques uniquement) ─────
-- (skip si elles ont des rows sans valeur — Supabase / Postgres bloquerait)
DO $$
BEGIN
  -- Seulement si table vide (sinon skip pour préserver rows existants)
  IF (SELECT COUNT(*) FROM public.gainers_insights_log) = 0 THEN
    BEGIN
      ALTER TABLE public.gainers_insights_log
        ALTER COLUMN insight_type SET NOT NULL,
        ALTER COLUMN source SET NOT NULL,
        ALTER COLUMN status SET NOT NULL,
        ALTER COLUMN severity SET NOT NULL,
        ALTER COLUMN summary SET NOT NULL,
        ALTER COLUMN payload SET NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'NOT NULL constraints skip (existing rows): %', SQLERRM;
    END;
  END IF;
END$$;

-- ─── Step 3 : CHECK constraints (idempotent via DROP + ADD) ────────────────
DO $$
BEGIN
  -- chk_status
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_status'
      AND conrelid = 'public.gainers_insights_log'::regclass
  ) THEN
    ALTER TABLE public.gainers_insights_log DROP CONSTRAINT chk_status;
  END IF;
  ALTER TABLE public.gainers_insights_log
    ADD CONSTRAINT chk_status CHECK (status IN ('open', 'investigating', 'actioned', 'dismissed'));

  -- chk_severity
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_severity'
      AND conrelid = 'public.gainers_insights_log'::regclass
  ) THEN
    ALTER TABLE public.gainers_insights_log DROP CONSTRAINT chk_severity;
  END IF;
  ALTER TABLE public.gainers_insights_log
    ADD CONSTRAINT chk_severity CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
END$$;

-- ─── Step 4 : Indexes (re-créer ceux qui ont fail dans 0110) ───────────────

CREATE INDEX IF NOT EXISTS idx_gainers_insights_type_created
  ON public.gainers_insights_log (insight_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_gainers_insights_open
  ON public.gainers_insights_log (status) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_gainers_insights_severity
  ON public.gainers_insights_log (severity, created_at DESC)
  WHERE severity IN ('high', 'critical');

-- ─── Step 5 : RLS policy (idempotent) ──────────────────────────────────────

ALTER TABLE public.gainers_insights_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_insights_full_access" ON public.gainers_insights_log;
CREATE POLICY "service_role_insights_full_access"
  ON public.gainers_insights_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.gainers_insights_log IS 'Phase A — log structuré pour modèle V1 auto-apprenant. Réparé 0113 après 0110 partial apply.';
