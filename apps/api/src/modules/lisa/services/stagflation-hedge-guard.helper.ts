/**
 * Stagflation hedge guard — bloque le scanner d'ouvrir des positions sur
 * les tickers du watchlist `stagflation_hedge` (métaux, énergie, défensifs,
 * govt bonds), env-gated.
 *
 * Justification empirique (audit lisa_trade_outcomes 23/05) :
 *   25 trades historiques avec open_regime='stagflation' (ancien classifier
 *   Lisa LLM era avr/2026) → sum -$3,463, mean -$138/trade. 3 trades à -100%
 *   (URA/PPLT/CPER closed_kill). Asset class hits : commodities_metals_precious
 *   -$2,901 / commodities_metals_industrial -$1,500.
 *
 * Le scanner gainers actuel ne pull pas ces tickers du watchlist actif
 * (sp500/nasdaq100/etc), mais ce guard est une assurance défensive :
 *   - Si quelqu'un active `stagflation_hedge` dans REBOUND_UNIVERSE
 *   - Si futur OHLCV cache pull étend l'univers
 *   - Si un futur regime classifier émet stagflation et qu'on veut
 *     skipper ces tickers en cascade
 *
 * Gating : env `STAGFLATION_HEDGE_GUARD_ENABLED` (default false). Override
 * possible via env CSV `STAGFLATION_HEDGE_GUARD_TICKERS` pour customiser la liste.
 *
 * Aucune régression : OFF par défaut. ON → ajoute UN check supplémentaire en
 * début de filter chain, équivalent à un blacklist existant.
 */

const DEFAULT_STAGFLATION_HEDGE_TICKERS = [
  // Or physique + miniers
  'GLD.US', 'IAU.US', 'PHYS.US', 'GDX.US', 'GDXJ.US',
  'NEM.US', 'AEM.US', 'GOLD.US', 'FNV.US', 'WPM.US',
  // Argent
  'SLV.US', 'SIL.US', 'AG.US', 'PAAS.US',
  // Énergie / pétrole
  'USO.US', 'BNO.US', 'XLE.US', 'XOP.US', 'OXY.US',
  'CVX.US', 'COP.US', 'EOG.US', 'SLB.US',
  // Govt bonds / TIPS
  'TLT.US', 'IEF.US', 'TIPS.US', 'SCHP.US', 'IVOL.US',
  // Défensifs
  'XLP.US', 'XLU.US', 'KO.US', 'PG.US', 'JNJ.US',
  'WMT.US', 'COST.US', 'MCD.US',
];

export interface StagflationHedgeGuardConfig {
  enabled: boolean;
  tickers: Set<string>;
}

/**
 * Parse env vars pour produire la config runtime. Pure (no I/O).
 *
 * @param env – Object { STAGFLATION_HEDGE_GUARD_ENABLED?, STAGFLATION_HEDGE_GUARD_TICKERS? }
 */
export function parseStagflationHedgeGuardConfig(
  env: {
    STAGFLATION_HEDGE_GUARD_ENABLED?: string | undefined;
    STAGFLATION_HEDGE_GUARD_TICKERS?: string | undefined;
  },
): StagflationHedgeGuardConfig {
  const enabled = (env.STAGFLATION_HEDGE_GUARD_ENABLED ?? 'false').toLowerCase() === 'true';
  const override = env.STAGFLATION_HEDGE_GUARD_TICKERS;
  const list = override
    ? override.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_STAGFLATION_HEDGE_TICKERS;
  return { enabled, tickers: new Set(list) };
}

/**
 * Returns true si le symbole doit être skip par ce guard.
 * @returns true → skip. false → laisser passer.
 */
export function shouldSkipStagflationHedge(
  symbol: string,
  config: StagflationHedgeGuardConfig,
): boolean {
  if (!config.enabled) return false;
  return config.tickers.has(symbol.toUpperCase());
}

export const DEFAULT_STAGFLATION_HEDGE_LIST = DEFAULT_STAGFLATION_HEDGE_TICKERS;
