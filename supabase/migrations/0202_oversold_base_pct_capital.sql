-- 0202 — Sizing oversold en % du capital (auto-scale), par portfolio.
--
-- Avant : la base du sizing était un notionnel fixe en $ (oversold_position_notional_usd),
-- identique pour US ($150k) et EU ($20k) → le US sous-déployait massivement
-- ($1000 base = 0,67% de son capital) et tout changement de capital exigeait un
-- re-réglage manuel du ticket (cf. bug capital 08/06).
--
-- On ajoute une base en % du capital (prioritaire quand > 0) : base = capital × %.
-- Auto-scale avec le capital, risque cohérent entre portefeuilles. Le notionnel
-- fixe reste comme fallback (% = 0). Le multiplicateur de bande, l'amortisseur
-- VIX et le plancher/plafond 12% s'appliquent ensuite, inchangés.
--
-- Default 5% (choix user 08/06) : préserve l'EU à l'identique ($20k × 5% = $1000,
-- = l'ancien base fixe) et fait scaler le US ($150k × 5% = $7500).
ALTER TABLE lisa_session_configs
  ADD COLUMN IF NOT EXISTS oversold_size_base_pct_capital NUMERIC(5,2) DEFAULT 5
    CHECK (oversold_size_base_pct_capital IS NULL OR (oversold_size_base_pct_capital >= 0 AND oversold_size_base_pct_capital <= 100));
