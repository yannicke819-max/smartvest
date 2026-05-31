-- Migration 0181 — Table générique A/B shadow pour tous les call sites LLM
--
-- Contexte : suite à PR #519/520/521 (A/B shadow Pro/Flash/Mistral sur TRADER
-- décisions), extension aux 4 autres call sites Gemini :
--   1. Scanner Post-Mortem (cron 02:30 UTC daily, lessons generation)
--   2. Strategy Coach (cron hourly, recommendations)
--   3. Daily Catalyst Brief (cron daily, news brief)
--   4. Open Position Risk Monitor (cron 5min sur positions ouvertes)
--
-- Différence avec gemini_ab_decisions (TRADER-specific) :
--   - Cette table est générique avec call_site discriminator
--   - Output JSONB au lieu de colonnes typées (chaque site a un format différent)
--   - Une shadow = 1 row JSONB array element au lieu de N colonnes par provider
--
-- Permet :
--   - Aggregation cross-site dans /admin/llm-cost-live
--   - Comparaison concordance par site
--   - Ajout d'un 5e site sans migration (juste passer le nom de call_site)
--
-- Idempotente.

CREATE TABLE IF NOT EXISTS public.llm_ab_shadow_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at timestamptz NOT NULL DEFAULT NOW(),

  -- Discriminator : permet aggregations par site
  -- ('scanner_postmortem' | 'strategy_coach' | 'daily_brief' | 'risk_monitor')
  call_site text NOT NULL,

  -- Portfolio scope (NULL pour sites non-portfolio-scoped)
  portfolio_id uuid,

  -- Provider appliqué (celui dont la réponse a été utilisée par le service)
  applied_provider text NOT NULL,
  applied_response_summary text,  -- truncated à ~500 chars pour audit
  applied_cost_usd numeric(10, 6),
  applied_latency_ms int,
  applied_parse_ok boolean,

  -- Shadows : array JSONB des autres providers appelés en parallèle
  -- Format : [{ "provider": "gemini-flash", "cost_usd": 0.002, "latency_ms": 1450,
  --             "response_summary": "...", "error": null, "concordance_full": true }]
  shadows jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Concordance per shadow (pre-computed pour query rapides)
  -- Format : { "gemini-flash": true, "mistral-medium": true, "mistral-large": false }
  concordance_summary jsonb,

  -- Hashes pour valider que les shadows ont vu le même context que l'applied
  context_hash text,  -- sha256(user_prompt).slice(0,16)
  system_prompt_hash text,  -- sha256(system_prompt).slice(0,16) — détecte prompt drift

  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_ab_shadow_decided_at ON public.llm_ab_shadow_decisions(decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_ab_shadow_call_site_decided_at ON public.llm_ab_shadow_decisions(call_site, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_ab_shadow_portfolio_decided_at ON public.llm_ab_shadow_decisions(portfolio_id, decided_at DESC) WHERE portfolio_id IS NOT NULL;

COMMENT ON TABLE public.llm_ab_shadow_decisions IS
'A/B shadow comparison pour 4 call sites Gemini periphériques (PR #523). TRADER decisions restent dans gemini_ab_decisions (table dediee plus structuree). Permet decision data-driven : si Mistral Medium concorde >=85% avec Pro sur TOUS les sites pendant 7j, migration vers Mistral est validee globalement.';

COMMENT ON COLUMN public.llm_ab_shadow_decisions.call_site IS
'Discriminator: scanner_postmortem | strategy_coach | daily_brief | risk_monitor. Permet filtres + indexes. Extensible sans migration.';

COMMENT ON COLUMN public.llm_ab_shadow_decisions.shadows IS
'Array JSONB des providers shadows appeles en parallele. Chaque element : provider, cost_usd, latency_ms, response_summary, error, concordance_full. Format flexible permet ajouter des providers sans migration.';

COMMENT ON COLUMN public.llm_ab_shadow_decisions.applied_response_summary IS
'Truncated a ~500 chars. Pour audit forensique uniquement, pas pour replay (use case different de la replay infrastructure).';

-- RLS — service_role only (table interne, pas exposee user-facing)
ALTER TABLE public.llm_ab_shadow_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "llm_ab_shadow_service_only" ON public.llm_ab_shadow_decisions;
CREATE POLICY "llm_ab_shadow_service_only" ON public.llm_ab_shadow_decisions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
