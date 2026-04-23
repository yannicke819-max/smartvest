-- 0053_lisa_tactical_overrides.sql
-- Ajoute tactical_overrides à lisa_mechanical_directives.
-- Lisa instruit l'agent mécanique (qui n'est qu'un exécutant) via des
-- overrides fin-grain parsés depuis les warnings [AGENT] du proposal.
--
-- Format (JSON) :
--   {
--     "pauseOpens": boolean,
--     "pauseOpensReason": "stops_cluster" | "vix_spike" | "drawdown" |
--                         "exposure_high" | "choppiness" | "regime_break" | null,
--     "tightenStopsMultiplier": number,     // 0.5 = stops 2× plus serrés; 1.0 = normal; 1.5 = plus larges
--     "minConvictionOverride": number | null, // 0-10, surcharge le seuil trajectoire
--     "maxNewOpensOverride": number | null,   // surcharge le openCap trajectoire
--     "closeLowestConvictionIfExposureAbovePct": number | null, // ex: 75
--     "preferredAssetClasses": string[]       // ex: ["govt_bonds_us"] pendant un VIX spike
--   }

do $$ begin
  alter table public.lisa_mechanical_directives
    add column tactical_overrides jsonb not null default '{}'::jsonb;
exception when duplicate_column then null; end $$;

comment on column public.lisa_mechanical_directives.tactical_overrides is
  'Instructions fin-grain de Lisa au MechanicalTradingService, parsées depuis les warnings [AGENT] du proposal Claude';
