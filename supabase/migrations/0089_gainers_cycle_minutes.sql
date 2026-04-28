-- P9-UX — Cycle Gainers configurable par portfolio (UI selector).
--
-- Avant : le scanner Gainers utilisait une seule fréquence globale via env
-- `SCAN_INTERVAL_MINUTES`. UI affichait "Cycle 15 min" hardcoded sans
-- possibilité de modification.
--
-- Après : `lisa_session_configs.gainers_cycle_minutes` (1..60 min) est lu
-- par le scanner pour gater chaque portfolio individuellement (cache 30s).
-- L'utilisateur choisit la fréquence via un selector dans
-- GainersStatusTile. Range : 1, 5, 10, 15, 20, 30, 45, 60 min.
--
-- Le cron global continue de fonctionner à `SCAN_INTERVAL_MINUTES`. Les
-- portfolios dont le cycle est plus long sont gatés avec
-- `lastScanByPortfolio` en mémoire (skip si elapsed < cycle).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_cycle_minutes integer NOT NULL DEFAULT 15;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_cycle_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_cycle_check
      CHECK (gainers_cycle_minutes BETWEEN 1 AND 60);
  END IF;
END $$;

COMMENT ON COLUMN public.lisa_session_configs.gainers_cycle_minutes IS
  'P9-UX — Fréquence du scanner Gainers pour ce portfolio (1..60 min). UI selector dans GainersStatusTile. Default 15. Le scanner gate chaque portfolio individuellement (cache 30s, skip si elapsed depuis dernier scan < cycle). Effective cycle = max(env SCAN_INTERVAL_MINUTES, gainers_cycle_minutes).';

-- ─────────────────────────────────────────────────────────────────────────────
-- P9-UX ADDENDUM — Path quality / smoothness
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Détecte les pump-and-dump qui passent le gate persistence multi-TF mais
-- dont le path est chaotique (rebonds violents). Métrique : path efficiency
-- = |priceEnd - priceStart| / sum(|p_i - p_{i-1}|) ∈ [0,1]. 1.0 = monotone,
-- vers 0 = aléatoire.
--
-- gainers_min_path_efficiency : seuil min pour ouvrir une position. Default
-- 0.5 (50% efficient). Désactivé si null.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_min_path_efficiency numeric(3, 2) DEFAULT 0.5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lisa_session_configs_gainers_min_path_check'
      AND conrelid = 'public.lisa_session_configs'::regclass
  ) THEN
    ALTER TABLE public.lisa_session_configs
      ADD CONSTRAINT lisa_session_configs_gainers_min_path_check
      CHECK (gainers_min_path_efficiency IS NULL
             OR gainers_min_path_efficiency BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON COLUMN public.lisa_session_configs.gainers_min_path_efficiency IS
  'P9-UX ADDENDUM — Seuil min de path efficiency (∈ [0,1], default 0.5) pour ouvrir une position Gainers. NULL désactive le gate. Évite les pump-and-dump qui passent le gate persistence mais dont le path est chaotique.';
