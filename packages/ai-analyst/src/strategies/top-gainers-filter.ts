/**
 * P5-PIVOT-TOP-GAINERS — Pure filter logic for momentum candidates
 * cross-asset (US/EU/Asia equities, crypto, FX, commodities).
 *
 * Critères stricts (anti pump&dump, anti gap-and-fade) avec seuils
 * ADAPTATIFS par classe d'actif :
 *
 *   us_equity_large (MC>10B)   : changePct >= +3%
 *   us_equity_small_mid        : changePct >= +5%
 *   eu_equity                  : changePct >= +5%
 *   asia_equity                : changePct >= +5%
 *   crypto_major (top 4)       : changePct >= +3%
 *   crypto_alt                 : changePct >= +8% (bruit élevé)
 *   fx_major                   : changePct >= +0.5%
 *   fx_cross                   : changePct >= +1.5%
 *   commodity                  : changePct >= +1.5%
 *
 * Pure function : aucun I/O, testable sans mocks.
 */

export type TopGainerAssetClass =
  | 'us_equity_large'
  | 'us_equity_small_mid'
  | 'eu_equity'
  | 'asia_equity'
  | 'crypto_major'
  | 'crypto_alt'
  | 'fx_major'
  | 'fx_cross'
  | 'commodity';

const CRYPTO_MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL']);
const FX_MAJORS = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDCHF', 'DXY',
]);

/**
 * Détecte la classe d'actif à partir d'un ticker + exchange.
 */
export function detectAssetClass(
  symbol: string,
  exchange: string | null | undefined,
  marketCap: number | null = null,
): TopGainerAssetClass {
  const s = symbol.toUpperCase();
  const ex = (exchange ?? '').toUpperCase();

  // Crypto : exchange=BINANCE/CRYPTO ou pair pattern *USDT/*USDC
  if (ex === 'BINANCE' || ex === 'CRYPTO' || /^(BTC|ETH|BNB|SOL|XRP|ADA|DOT|MATIC|AVAX|LINK|DOGE|SHIB|TRX|ATOM).*USD[T|C]?$/.test(s)) {
    const base = s.replace(/USD[T|C]?$/, '');
    return CRYPTO_MAJORS.has(base) ? 'crypto_major' : 'crypto_alt';
  }

  // FX : exchange=FOREX/FX, pattern 6-char ou DXY
  if (ex === 'FOREX' || ex === 'FX' || /^[A-Z]{6}$/.test(s) || s === 'DXY') {
    return FX_MAJORS.has(s) ? 'fx_major' : 'fx_cross';
  }

  // Commodity : exchange=COMM/FUTURES ou suffix .COMM (EODHD : BRENT.COMM, etc.)
  // FIX 29/05/2026 : l'ancien regex /^[A-Z]{2,3}\.F$/ matchait TOUS les tickers
  // Frankfurt 2-3 lettres (.F = Frankfurt exchange, cf. CLAUDE.md BMW.F ≠ BMW.XETRA)
  // → 10/10 candidats Frankfurt mal classés 'commodity' au lieu de 'eu_equity',
  // donc bans EU + lessons eu_equity ne s'appliquaient pas. Les vrais futures
  // commodity EODHD utilisent .COMM (BRENT.COMM), pas .F.
  if (ex === 'COMM' || ex === 'FUTURES' || /\.COMM$/.test(s)) {
    return 'commodity';
  }

  // EU equity exchanges — 'F' (Frankfurt) ajouté 29/05.
  // FIX 01/06 : ajout 'TA' (Tel Aviv) et 'WAR' (Warsaw GPW) qui tombaient
  // dans le default fallthrough = us_equity_large. Bug observé : 57 .TA
  // tagués us_equity_large dans top_gainers_log → stats par classe + filtres
  // par classe + lessons par scope tous faussés.
  if (['LSE', 'XETRA', 'PA', 'AMS', 'BR', 'SW', 'BME', 'MI', 'STO', 'L', 'DE', 'F', 'TA', 'WAR', 'AS', 'MC'].includes(ex)) {
    return 'eu_equity';
  }
  // EU equity par suffix (cas où exchange n'est pas fourni mais le ticker l'indique).
  if (/\.(LSE|XETRA|PA|AS|BR|SW|MI|MC|L|DE|F|TA|WAR)$/.test(s)) {
    return 'eu_equity';
  }
  // Asia equity exchanges
  // P20a: SHG/SHE are the corrected EODHD codes for Shanghai/Shenzhen (was SS/SZ).
  // TSE kept for backward compat with historical top_gainers_log entries.
  if (['T', 'TSE', 'HK', 'AU', 'NSE', 'BSE', 'KO', 'KQ', 'KRX', 'HKEX', 'SHG', 'SHE'].includes(ex)) {
    return 'asia_equity';
  }
  // Default = US equity, large vs small/mid via marketCap
  if (marketCap !== null && Number.isFinite(marketCap) && marketCap >= 10_000_000_000) {
    return 'us_equity_large';
  }
  return 'us_equity_small_mid';
}

/**
 * Seuils par classe d'actif. Caller peut override via une copie modifiée.
 */
export const DEFAULT_THRESHOLDS: Record<TopGainerAssetClass, {
  minChangePct: number;
  minPrice: number;
  minMarketCap: number;
  minAvgVol50d: number;
  minVolRatio: number;
  minCloseToHighRatio: number;
}> = {
  us_equity_large:    { minChangePct: 3,   minPrice: 5,      minMarketCap: 10_000_000_000, minAvgVol50d: 500_000, minVolRatio: 1.5, minCloseToHighRatio: 0.80 },
  us_equity_small_mid:{ minChangePct: 5,   minPrice: 5,      minMarketCap: 100_000_000,    minAvgVol50d: 500_000, minVolRatio: 1.5, minCloseToHighRatio: 0.80 },
  eu_equity:          { minChangePct: 5,   minPrice: 5,      minMarketCap: 100_000_000,    minAvgVol50d: 200_000, minVolRatio: 1.5, minCloseToHighRatio: 0.80 },
  asia_equity:        { minChangePct: 5,   minPrice: 1,      minMarketCap: 50_000_000,     minAvgVol50d: 200_000, minVolRatio: 1.5, minCloseToHighRatio: 0.80 },
  crypto_major:       { minChangePct: 3,   minPrice: 0.0001, minMarketCap: 500_000_000,    minAvgVol50d: 0,       minVolRatio: 0,   minCloseToHighRatio: 0.85 },
  crypto_alt:         { minChangePct: 8,   minPrice: 0.0001, minMarketCap: 500_000_000,    minAvgVol50d: 0,       minVolRatio: 0,   minCloseToHighRatio: 0.85 },
  fx_major:           { minChangePct: 0.5, minPrice: 0,      minMarketCap: 0,              minAvgVol50d: 0,       minVolRatio: 0,   minCloseToHighRatio: 0.85 },
  fx_cross:           { minChangePct: 1.5, minPrice: 0,      minMarketCap: 0,              minAvgVol50d: 0,       minVolRatio: 0,   minCloseToHighRatio: 0.85 },
  commodity:          { minChangePct: 1.5, minPrice: 0,      minMarketCap: 0,              minAvgVol50d: 0,       minVolRatio: 0,   minCloseToHighRatio: 0.85 },
};

export interface TopGainerCandidate {
  symbol: string;
  exchange: string | null;
  assetClass?: TopGainerAssetClass;
  close: number;
  high: number;
  changePct: number;
  volume: number;
  avgVol50d: number;
  marketCap: number;
}

export interface TopGainerEvaluation {
  passes: boolean;
  reasons: string[];
  score: number;
  assetClass: TopGainerAssetClass;
}

export function evaluateTopGainerCandidate(c: TopGainerCandidate): TopGainerEvaluation {
  // Sanity
  if (
    !Number.isFinite(c.close) ||
    !Number.isFinite(c.high) ||
    !Number.isFinite(c.changePct) ||
    !Number.isFinite(c.volume) ||
    c.close <= 0 ||
    c.high <= 0 ||
    c.high < c.close
  ) {
    return { passes: false, reasons: ['invalid_data'], score: 0, assetClass: 'us_equity_small_mid' };
  }

  const assetClass = c.assetClass ?? detectAssetClass(c.symbol, c.exchange, c.marketCap);
  const f = DEFAULT_THRESHOLDS[assetClass];
  const reasons: string[] = [];

  if (c.changePct < f.minChangePct) {
    reasons.push(`changePct=${c.changePct.toFixed(2)}<${f.minChangePct}`);
  }
  if (f.minPrice > 0 && c.close < f.minPrice) {
    reasons.push(`price=${c.close.toFixed(2)}<${f.minPrice}`);
  }
  if (f.minMarketCap > 0 && c.marketCap < f.minMarketCap) {
    reasons.push(`mcap=${(c.marketCap / 1e6).toFixed(0)}M<${(f.minMarketCap / 1e6).toFixed(0)}M`);
  }
  if (f.minAvgVol50d > 0 && c.avgVol50d < f.minAvgVol50d) {
    reasons.push(`avgVol50d=${(c.avgVol50d / 1000).toFixed(0)}k<${(f.minAvgVol50d / 1000).toFixed(0)}k`);
  }
  if (f.minVolRatio > 0) {
    const volRatio = c.avgVol50d > 0 ? c.volume / c.avgVol50d : 0;
    if (volRatio < f.minVolRatio) {
      reasons.push(`volRatio=${volRatio.toFixed(2)}<${f.minVolRatio}`);
    }
  }
  const closeToHigh = c.high > 0 ? c.close / c.high : 0;
  if (closeToHigh < f.minCloseToHighRatio) {
    reasons.push(`closeToHigh=${closeToHigh.toFixed(2)}<${f.minCloseToHighRatio} gap-and-fade`);
  }

  if (reasons.length > 0) {
    return { passes: false, reasons, score: 0, assetClass };
  }

  // Score composite : changeMargin + closeStrength (+ volMargin si applicable).
  const changeMargin = Math.min(1, Math.max(0, (c.changePct - f.minChangePct) / Math.max(1, f.minChangePct * 2)));
  const closeStrength = Math.min(1, Math.max(0, (closeToHigh - f.minCloseToHighRatio) / Math.max(0.001, 1 - f.minCloseToHighRatio)));
  let score: number;
  if (f.minAvgVol50d > 0 && c.avgVol50d > 0) {
    const volMargin = Math.min(1, Math.max(0, (c.volume / c.avgVol50d - f.minVolRatio) / 3));
    score = (changeMargin + volMargin + closeStrength) / 3;
  } else {
    score = (changeMargin + closeStrength) / 2;
  }

  return {
    passes: true,
    reasons: [],
    score: Math.round(score * 100) / 100,
    assetClass,
  };
}

/**
 * Filter + sort un univers de candidats CROSS-ASSET. Retourne top N
 * par score décroissant, toutes classes confondues.
 */
export function selectTopGainers(
  candidates: TopGainerCandidate[],
  topN: number = 3,
): Array<TopGainerCandidate & { score: number; assetClass: TopGainerAssetClass }> {
  const passing = candidates
    .map((c) => ({ candidate: c, eval: evaluateTopGainerCandidate(c) }))
    .filter((x) => x.eval.passes)
    .map((x) => ({ ...x.candidate, score: x.eval.score, assetClass: x.eval.assetClass }))
    .sort((a, b) => b.score - a.score);
  return passing.slice(0, topN);
}
