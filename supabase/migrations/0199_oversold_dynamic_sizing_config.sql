-- 0199 — Paramètres du sizing dynamique oversold, par portfolio (éditables depuis l'UI).
--
-- Le sizing dynamique (notional = base × mult(bande) × amortisseur(VIX), borné
-- plancher/plafond) était piloté par env globaux. On le passe en DB par-portfolio
-- pour que l'utilisateur le règle depuis une carte UI (demande user 08/06/2026).
-- DB > env > défaut code (cf. resolveConfig dans oversold-scanner.service.ts).
ALTER TABLE lisa_session_configs
  ADD COLUMN IF NOT EXISTS oversold_size_dynamic_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS oversold_size_band_mult_deep NUMERIC(5,2) DEFAULT 2.0,      -- bande -8/-12%
  ADD COLUMN IF NOT EXISTS oversold_size_band_mult_shallow NUMERIC(5,2) DEFAULT 1.0,   -- bande -5/-8%
  ADD COLUMN IF NOT EXISTS oversold_size_vix_damp_elevated NUMERIC(5,2) DEFAULT 0.8,   -- VIX 20-30
  ADD COLUMN IF NOT EXISTS oversold_size_vix_damp_stress NUMERIC(5,2) DEFAULT 0.5,     -- VIX >=30
  ADD COLUMN IF NOT EXISTS oversold_size_floor_usd NUMERIC(12,2) DEFAULT 500,          -- plancher absolu
  ADD COLUMN IF NOT EXISTS oversold_size_ceiling_pct_capital NUMERIC(5,2) DEFAULT 12;  -- plafond % capital
