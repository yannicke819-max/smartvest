/**
 * P3-C — Univers de tickers pour le scanner rebound-tp.
 *
 * Source de vérité TypeScript pour les listes statiques. La migration
 * 0079_watchlist_universe.sql seed la table `watchlist_universe` avec
 * les MÊMES arrays (sync manuel à chaque update — voir CLAUDE.md).
 *
 * Le runtime peut soit lire la table (si configurée), soit fallback sur
 * ces constantes. Liste élargie de 12 → ~200 (S&P 500 top par capitalisation)
 * pour passer la cible de 0.06 signal/jour à 2-4 signaux/jour.
 *
 * Format ticker EODHD : `XXX.US` pour stocks US.
 */

/**
 * Watchlist legacy P3-A.2 — 12 mega-caps. Conservé comme fallback
 * conservateur si l'utilisateur veut limiter les coûts EODHD.
 */
export const MEGA12_UNIVERSE = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'META.US', 'GOOGL.US', 'TSLA.US',
  'AMD.US', 'AVGO.US', 'SPY.US', 'QQQ.US', 'IWM.US', 'XOM.US',
];

/**
 * S&P 500 — ~200 top par capitalisation (approche ~85% de la pondération
 * de l'index). Liste manuelle synchronisée à la date du commit.
 *
 * Note : la liste S&P 500 évolue (rebalancing trimestriel). Le re-sync
 * complet se fait via `npm run sync:sp500` (deferred P3-D).
 */
export const SP500_UNIVERSE = [
  // Top 50
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'GOOG.US', 'META.US', 'TSLA.US',
  'AVGO.US', 'BRK-B.US', 'LLY.US', 'JPM.US', 'V.US', 'XOM.US', 'WMT.US', 'UNH.US',
  'MA.US', 'PG.US', 'JNJ.US', 'HD.US', 'COST.US', 'ORCL.US', 'NFLX.US', 'ABBV.US',
  'BAC.US', 'CRM.US', 'KO.US', 'CVX.US', 'MRK.US', 'AMD.US', 'PEP.US', 'TMO.US',
  'ADBE.US', 'CSCO.US', 'LIN.US', 'ABT.US', 'WFC.US', 'MCD.US', 'ACN.US', 'NOW.US',
  'IBM.US', 'TXN.US', 'GE.US', 'PM.US', 'INTU.US', 'DIS.US', 'AXP.US', 'CAT.US',
  'GS.US', 'ISRG.US',
  // 51-100
  'BKNG.US', 'MS.US', 'VZ.US', 'RTX.US', 'PFE.US', 'T.US', 'NEE.US', 'AMGN.US',
  'BLK.US', 'TJX.US', 'SCHW.US', 'C.US', 'BX.US', 'BSX.US', 'SYK.US', 'AMAT.US',
  'PGR.US', 'LOW.US', 'BMY.US', 'ETN.US', 'PANW.US', 'HON.US', 'TMUS.US', 'VRTX.US',
  'UNP.US', 'PLD.US', 'CMCSA.US', 'ADP.US', 'COP.US', 'GILD.US', 'CB.US', 'DE.US',
  'ANET.US', 'SBUX.US', 'KLAC.US', 'MDT.US', 'MMC.US', 'BA.US', 'NKE.US', 'LRCX.US',
  'LMT.US', 'ELV.US', 'CI.US', 'MU.US', 'INTC.US', 'ICE.US', 'MO.US', 'SO.US',
  'AMT.US', 'EQIX.US',
  // 101-150
  'GEV.US', 'ADI.US', 'WM.US', 'CRWD.US', 'DUK.US', 'CME.US', 'SHW.US', 'WELL.US',
  'APH.US', 'CDNS.US', 'CMG.US', 'PYPL.US', 'KKR.US', 'SNPS.US', 'EOG.US', 'AON.US',
  'ZTS.US', 'MCK.US', 'USB.US', 'ITW.US', 'PNC.US', 'COF.US', 'TGT.US', 'MMM.US',
  'MAR.US', 'CL.US', 'NOC.US', 'GD.US', 'FCX.US', 'F.US', 'TFC.US', 'EMR.US',
  'PH.US', 'MCO.US', 'HCA.US', 'ECL.US', 'MSI.US', 'CSX.US', 'APD.US', 'ORLY.US',
  'AJG.US', 'CARR.US', 'OKE.US', 'BDX.US', 'PCAR.US', 'WMB.US', 'NSC.US', 'TT.US',
  'AFL.US', 'TRV.US',
  // 151-200
  'ROP.US', 'FI.US', 'PSA.US', 'NXPI.US', 'AZO.US', 'JCI.US', 'O.US', 'PSX.US',
  'KMB.US', 'SLB.US', 'AIG.US', 'GM.US', 'CHTR.US', 'NEM.US', 'AEP.US', 'MET.US',
  'COR.US', 'ADSK.US', 'SPGI.US', 'BK.US', 'D.US', 'ROST.US', 'TEL.US', 'AMP.US',
  'STZ.US', 'KHC.US', 'GIS.US', 'KMI.US', 'EW.US', 'TRGP.US', 'CTSH.US', 'EXC.US',
  'PRU.US', 'A.US', 'PCG.US', 'SRE.US', 'CCI.US', 'DLR.US', 'ALL.US', 'MNST.US',
  'YUM.US', 'WCN.US', 'GWW.US', 'PWR.US', 'VST.US', 'PAYX.US', 'KR.US', 'OXY.US',
  'CTVA.US', 'LHX.US',
];

/**
 * NASDAQ-100 (~100 tickers tech-heavy). Recouvrement avec SP500 sur
 * les mega-caps (AAPL/MSFT/NVDA…) — à dédupliquer côté caller.
 */
export const NASDAQ100_UNIVERSE = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'GOOG.US', 'META.US',
  'TSLA.US', 'AVGO.US', 'COST.US', 'NFLX.US', 'TMUS.US', 'ADBE.US', 'AMD.US',
  'PEP.US', 'CSCO.US', 'INTC.US', 'CMCSA.US', 'TXN.US', 'QCOM.US', 'AMAT.US',
  'BKNG.US', 'INTU.US', 'AMGN.US', 'HON.US', 'ISRG.US', 'VRTX.US', 'ADP.US',
  'GILD.US', 'PANW.US', 'KLAC.US', 'LRCX.US', 'REGN.US', 'SBUX.US', 'MU.US',
  'MELI.US', 'MDLZ.US', 'PYPL.US', 'CRWD.US', 'CDNS.US', 'SNPS.US', 'CTAS.US',
  'MAR.US', 'CHTR.US', 'ORLY.US', 'ABNB.US', 'ASML.US', 'AZN.US', 'DASH.US',
  'WDAY.US', 'NXPI.US', 'ROP.US', 'PCAR.US', 'PAYX.US', 'MNST.US', 'ROST.US',
  'CPRT.US', 'KDP.US', 'ADSK.US', 'FAST.US', 'ODFL.US', 'EA.US', 'EXC.US',
  'KHC.US', 'CSGP.US', 'CTSH.US', 'IDXX.US', 'BIIB.US', 'TTWO.US', 'XEL.US',
  'GEHC.US', 'CCEP.US', 'ON.US', 'DDOG.US', 'TEAM.US', 'CDW.US', 'FANG.US',
  'ARM.US', 'ZS.US', 'ANSS.US', 'TTD.US', 'MRVL.US', 'WBD.US', 'PDD.US',
];

/**
 * P13 — Univers stagflation hedge.
 *
 * Tickers optimaux pour régime stagflation (inflation + croissance faible) :
 * or/argent physiques et miners, énergie, obligations longues (flight-to-safety),
 * défensives (consommation de base, utilities), ETFs de protection inflation.
 *
 * Format EODHD : XXX.US pour US-listés.
 * DB sync : migration 0091_p13_stagflation_universe.sql (watchlist 'stagflation_hedge').
 *
 * Graceful skip : si EODHD retourne 404 sur un ETF (plan insuffisant), le scanner
 * skip silencieusement ce ticker sans crash (gestion côté OhlcvCacheService).
 */
export const STAGFLATION_HEDGE_UNIVERSE = [
  // Métaux précieux — or (physique ETF + miners)
  'GLD.US', 'IAU.US', 'PHYS.US',    // or physique ETFs
  'GDX.US', 'GDXJ.US',              // miners or large/junior
  'NEM.US', 'AEM.US', 'GOLD.US',    // miners individuels (Newmont, Agnico Eagle, Barrick)
  'FNV.US', 'WPM.US',               // royalties or (Franco-Nevada, Wheaton)
  // Argent — physique + miners
  'SLV.US', 'SIL.US',               // argent physique + miners argent ETF
  'AG.US', 'PAAS.US',               // miners argent (First Majestic, Pan American Silver)
  // Énergie — pétrole + services
  'USO.US', 'BNO.US',               // pétrole (WTI / Brent ETFs)
  'XLE.US', 'XOP.US',               // secteur énergie + E&P ETFs
  'OXY.US', 'CVX.US', 'COP.US', 'EOG.US', 'SLB.US',  // majors + services
  // Obligations et protection inflation
  'TLT.US', 'IEF.US',               // Treasuries long/medium (flight-to-quality)
  'TIPS.US', 'SCHP.US', 'IVOL.US',  // ETFs indexés inflation (TIPS + stratégie convexité)
  // Défensives — consommation de base + utilities
  'XLP.US', 'XLU.US',               // secteurs défensifs ETFs
  'KO.US', 'PG.US', 'JNJ.US', 'WMT.US', 'COST.US', 'MCD.US', // consommation de base
];

/**
 * P13 — Univers crypto tradable via paper broker (Binance).
 *
 * BTC/ETH/SOL proposables par Lisa en régime risk_on ou comme hedge non-corrélé.
 * Format EODHD : XXX-USD.CC. Le runtime utilise Binance pour le prix live.
 * Graceful skip si Binance est indisponible.
 */
export const CRYPTO_TRADABLE_UNIVERSE = [
  'BTC-USD.CC', 'ETH-USD.CC', 'SOL-USD.CC',
];

export type UniverseName =
  | 'sp500'
  | 'nasdaq100'
  | 'mega12'
  | 'stagflation_hedge'
  | 'crypto_tradable';

/**
 * Retourne la liste de tickers pour un univers donné.
 * Utilisé en fallback quand watchlist_universe DB est inaccessible.
 */
export function getUniverseTickers(name: UniverseName): string[] {
  switch (name) {
    case 'sp500':
      return [...SP500_UNIVERSE];
    case 'nasdaq100':
      return [...NASDAQ100_UNIVERSE];
    case 'mega12':
      return [...MEGA12_UNIVERSE];
    case 'stagflation_hedge':
      return [...STAGFLATION_HEDGE_UNIVERSE];
    case 'crypto_tradable':
      return [...CRYPTO_TRADABLE_UNIVERSE];
  }
}

/**
 * P13 — Mapping régime macro → tickers tactiques recommandés pour Lisa.
 *
 * Utilisé par le bloc persona 09-regime-tactical-tickers et les tests.
 * Clés = valeurs de MarketRegime (types/index.ts).
 */
export const REGIME_TICKER_MAP: Record<string, string[]> = {
  stagflation:     ['GLD', 'GDX', 'SLV', 'USO', 'XLE', 'COP', 'OXY', 'TLT', 'XLU', 'XLP'],
  risk_off:        ['TLT', 'XLU', 'XLP', 'GLD', 'JNJ', 'KO', 'PG'],
  risk_on:         ['SPY', 'QQQ', 'IWM', 'NVDA', 'AVGO', 'BTC-USD', 'ETH-USD'],
  inflation:       ['GLD', 'SLV', 'USO', 'XLE', 'TIPS', 'COP'],
  growth_slowdown: ['TLT', 'XLP', 'XLU', 'GLD'],
};

/** Conviction override par régime (vs défaut persona 8). */
export const REGIME_MIN_CONVICTION: Record<string, number> = {
  stagflation:     6,
  risk_off:        6,
  growth_slowdown: 7,
};

/** Conviction par défaut quand aucun override n'est défini pour le régime. */
export const DEFAULT_MIN_CONVICTION = 8;
