-- 0123_gainers_session_filter
--
-- PR #266 — Filtrage automatique des places de marché par horaires +
-- force-close avant la cloche.
--
-- 1. session_filter_enabled : skip un asset class quand sa bourse est
--    fermée (US 14:30-21:00 UTC, EU 08:00-16:30 UTC, Asia 00:00-08:00 UTC).
--    Crypto 24/7 jamais affecté. Économise ~30-50% des appels EODHD.
--
-- 2. force_close_before_close : ferme automatiquement les positions
--    sur un marché qui s'apprête à fermer (offset T-N min). Évite le
--    gap risk overnight sur stratégie momentum intraday (TP 1.5%/SL 1.5%).
--    Crypto jamais force-close.

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_session_filter_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_force_close_before_close_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_force_close_offset_min INT NOT NULL DEFAULT 30
    CHECK (gainers_force_close_offset_min BETWEEN 5 AND 120);

COMMENT ON COLUMN public.lisa_session_configs.gainers_session_filter_enabled IS
  'PR #266 — Quand true, skip US/EU/Asia hors horaires session UTC. Crypto toujours scanné.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_force_close_before_close_enabled IS
  'PR #266 — Quand true, force-close les positions sur un marché à T-N min de sa fermeture.';

COMMENT ON COLUMN public.lisa_session_configs.gainers_force_close_offset_min IS
  'PR #266 — Offset en minutes avant clôture pour force-close (5..120, default 30).';
