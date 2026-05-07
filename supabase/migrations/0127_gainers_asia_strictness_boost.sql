-- 0127_gainers_asia_strictness_boost
--
-- PR #271 — Boost de strictness pour les marchés Asia (additif aux gates).
--
-- Constat 07/05/2026 : 4 SL consécutifs sur Asia low-cap (000783.SHE x2,
-- 001500.KO, 089010.KQ). Tous étaient (choppy) avec pathEff 0.40-0.49 et
-- persistence 3-5/6 — ils passaient les gates user (path=0.40, persistence=0.50)
-- mais échouaient sur le marché réel.
--
-- Causes structurelles Asia :
--   - Tickers small-cap KOSDAQ/Shenzhen avec liquidité faible → ticks larges
--   - Pumps 1-2% sur low-cap = artifact tick, pas un vrai momentum
--   - Trend de fond souvent baissier → le pump 1m est dead-cat bounce
--
-- Solution : booste les seuils path_eff et persistence pour les candidats
-- de classe `asia_equity` uniquement. Additif (pas multiplicatif) pour
-- prédictibilité user. Default +0.10 (= path 0.40 → 0.50, persistence 0.50 → 0.60).

ALTER TABLE public.lisa_session_configs
  ADD COLUMN IF NOT EXISTS gainers_asia_strictness_boost NUMERIC(3,2)
  DEFAULT 0.10
  CHECK (gainers_asia_strictness_boost IS NULL OR
         (gainers_asia_strictness_boost >= 0 AND gainers_asia_strictness_boost <= 0.50));

COMMENT ON COLUMN public.lisa_session_configs.gainers_asia_strictness_boost IS
  'PR #271 — Boost additif aux gates path_eff et persistence pour les candidats '
  'asia_equity uniquement. Compense la choppy nature des small-caps Asia. '
  'Range [0..0.50], default 0.10. 0 = pas de boost (Asia traité comme US/EU).';
