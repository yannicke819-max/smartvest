/**
 * Symbol → EODHD provider ticker conversion (subset).
 *
 * Permet à MarketDataService.refreshQuotes() de construire un ProviderAsset
 * directement depuis un row `lisa_positions` (symbol + asset_class) sans
 * dépendre d'un mapping pré-existant dans la table `assets`.
 *
 * INCIDENT 27/04/2026 : `MarketDataScheduler` retournait 0/0 succeeded car
 * `getProviderAssets()` filtrait `assets.provider_tickers != '{}'` qui
 * retournait 0 — la table `assets` n'avait pas (ou plus) de mappings pour
 * les tickers actifs (BTC, RTX). Conséquence : aucun prix rafraîchi, donc
 * aucun stop/TP ne se déclenchait au mécanique côté `lisa_positions`
 * (couplé au bug snake_case/camelCase fixé en PR #16).
 *
 * Couvre les cas suffisants pour débloquer la prod :
 *   - crypto : BTC/ETH/SOL/... → `{SYM}-USD.CC`
 *   - equity / ETF : AAPL/RTX/SPY/... → `{SYM}.US`
 *   - FX paires 6 lettres : EURUSD/USDJPY/... → `{SYM}.FOREX`
 *
 * Cas non gérés (retourne null, à étendre plus tard) :
 *   - ADRs spécifiques (TSM, BABA — généralement `.US` fonctionne)
 *   - Equities EU avec MIC code (ex. ASML.AS, MC.PA)
 *   - Bonds (US10Y, US2Y nécessitent un format dédié)
 *   - Indices avec préfixe (^VIX, ^SPX — gérés par fetchCascade côté Lisa)
 */
import type { ProviderAsset } from '../providers/market-data-provider.interface';

const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX',
  'MATIC', 'LINK', 'ATOM', 'UNI', 'LTC', 'NEAR', 'ARB', 'OP',
]);

/**
 * Construit un ProviderAsset EODHD à partir d'un symbol + asset_class.
 * Retourne null si la combinaison n'est pas couverte (caller fallback).
 *
 * @param assetId — id d'asset à utiliser pour le quote save (typiquement
 *   l'id de la position, à défaut un UUID synthétique side-effect-free).
 * @param symbol — ticker brut (BTC, RTX, EURUSD, ...). Insensible à la casse.
 * @param assetClass — `asset_class` de la position (snake_case enum), ou
 *   undefined / null si non disponible (heuristique sur symbol).
 * @param currency — devise locale (default 'USD').
 */
export function symbolToProviderAsset(
  assetId: string,
  symbol: string,
  assetClass: string | null | undefined,
  currency: string = 'USD',
): ProviderAsset | null {
  if (!symbol) return null;
  const sym = symbol.toUpperCase().trim();
  const cls = (assetClass ?? '').toLowerCase();

  // Si déjà un format EODHD complet (contient un '.'), le respecter tel quel.
  if (sym.includes('.')) {
    return { assetId, ticker: sym, providerTicker: sym, currency };
  }

  // Crypto : asset_class crypto_* OU symbol dans whitelist.
  const isCrypto = cls.startsWith('crypto_') || CRYPTO_SYMBOLS.has(sym) ||
    sym.endsWith('USDT') || sym.endsWith('-USD') || sym.endsWith('-SPOT');
  if (isCrypto) {
    // Normalize : BTCUSDT → BTC, BTC-USD → BTC, BTC-SPOT → BTC
    const base = sym
      .replace(/USDT$/, '')
      .replace(/-USD$/, '')
      .replace(/-SPOT$/, '');
    if (!base) return null;
    return {
      assetId,
      ticker: base,
      providerTicker: `${base}-USD.CC`,
      currency,
    };
  }

  // FX 6 lettres : EURUSD, USDJPY, GBPUSD, ...
  if (cls.startsWith('fx_') || /^[A-Z]{6}$/.test(sym)) {
    return {
      assetId,
      ticker: sym,
      providerTicker: `${sym}.FOREX`,
      currency,
    };
  }

  // Equity / ETF / commodity ETF / bond ETF : suffixe .US (default raisonnable
  // — couvre AAPL/RTX/SPY/QQQ/GLD/SLV/TLT/HYG/LQD/VXX/UUP). Les EU/JP/etc.
  // sont gérés par le mapping `assets.provider_tickers` qui prend le pas
  // (cf. union dans MarketDataService.getActiveSymbolsForRefresh).
  return {
    assetId,
    ticker: sym,
    providerTicker: `${sym}.US`,
    currency,
  };
}
