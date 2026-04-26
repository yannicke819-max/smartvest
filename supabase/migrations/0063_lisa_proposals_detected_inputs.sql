-- 0063 — Snapshot des inputs marché au moment de chaque proposal Lisa
--
-- Permet le mode event-driven : à chaque tick (60s), MaterialChangeDetector
-- compare les inputs actuels au snapshot du dernier cycle Lisa. Si delta
-- matériel détecté (VIX, prix tenus, funding, news, drawdown), trigger un
-- nouveau cycle immédiat au lieu d'attendre l'intervalle 20 min.
--
-- Format du snapshot :
--   {
--     "vix": 18.5,
--     "dxy": 102.3,
--     "prices_held": { "BTC": 77338, "RTX": 174.26, "GLD": 433.25 },
--     "funding_held": { "BTC": -0.4 },
--     "drawdown_pct": -0.07,
--     "top_news_hash": "sha256...",
--     "snapshot_at": "2026-04-26T06:28:56Z"
--   }
--
-- Optionnel — pas de NOT NULL pour rétrocompat avec proposals existantes.

ALTER TABLE public.lisa_proposals
  ADD COLUMN IF NOT EXISTS detected_inputs jsonb;

COMMENT ON COLUMN public.lisa_proposals.detected_inputs IS
  'Snapshot des inputs marché au moment de la génération de cette proposal. Sert de baseline pour le MaterialChangeDetector qui décide de trigger ou skip le prochain cycle event-driven.';

-- Trace du dernier trigger event-driven pour visibilité UI
ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS last_event_trigger_reason text,
  ADD COLUMN IF NOT EXISTS last_event_trigger_at timestamptz;

COMMENT ON COLUMN public.lisa_session_configs.last_event_trigger_reason IS
  'Raison du dernier déclenchement event-driven (ex: "VIX +0.6", "BTC +0.8%", "news catalyst score 85"). Affiché dans /lisa pour transparence.';
