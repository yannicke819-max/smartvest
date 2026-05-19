/**
 * PR #345 — helpers purs pour les filtres TwelveData branchés sur le scanner gainers.
 *
 * Logique extraite en module pour tester unitairement sans booter le scanner
 * (TopGainersScannerService = 2700 LOC, dépendances DI lourdes).
 *
 * Filtres :
 *   1. Supertrend US equity 30m   : reject si direction='down' (us_equity_large/small_mid)
 *   2. RSI crypto 5m surachat     : reject si value > 75 (crypto_major)
 *   3. Supertrend asia equity 30m : reject si direction='down' (asia_equity) — PR #360
 *
 * Le filtre ne court PAS si :
 *   - le flag d'env est désactivé (default OFF)
 *   - asset_class ne correspond pas
 *   - TwelveData retourne null (fail-open : signal passe)
 *   - le symbole n'est pas mappable (.MI / .T / .HK / .AU non supportés sur TD Pro)
 */

import type { TwelveDataService } from './twelve-data.service';
import { eodhdToTdSymbol } from './td-symbol-mapper';

export type ScannerFilterDecision =
  | { decision: 'accept' }
  | { decision: 'reject_supertrend_down'; reason: string }
  | { decision: 'reject_rsi_overbought'; reason: string }
  | { decision: 'reject_supertrend_asia_down'; reason: string };

const US_CLASSES = new Set(['us_equity_large', 'us_equity_small_mid']);
const CRYPTO_CLASSES = new Set(['crypto_major']);
const ASIA_CLASSES = new Set(['asia_equity']);
const RSI_OVERBOUGHT_THRESHOLD = 75;

export interface FilterContext {
  symbol: string;
  assetClass: string;
  supertrendEnabled: boolean;
  cryptoRsiEnabled: boolean;
  /** PR #360 — default false pour rétro-compat avec callers existants (PR #345). */
  asiaSupertrendEnabled?: boolean;
  twelveData: TwelveDataService;
}

/**
 * Applique les filtres TwelveData dans l'ordre :
 *   1. Supertrend US (si flag ON + asset_class US)
 *   2. RSI crypto (si flag ON + asset_class crypto)
 *
 * Retourne `{ decision: 'accept' }` si tous les filtres passent (ou sont OFF).
 * Sinon, le 1er filtre qui bloque renvoie son decision + reason.
 *
 * Fail-open : tout retour `null` de TwelveData (clé absente, rate limit, etc.)
 * est traité comme "info indisponible → on laisse passer".
 */
export async function evaluateTwelveDataFilters(
  ctx: FilterContext,
): Promise<ScannerFilterDecision> {
  // Filtre 1 — Supertrend US 30m
  if (ctx.supertrendEnabled && US_CLASSES.has(ctx.assetClass)) {
    // PR #355 — strip suffixe EODHD avant l'appel TD (AAPL.US → AAPL).
    // Avant : `ctx.symbol` passé tel quel à TD → 404/erreur silencieuse
    // côté TD pour 100% des US équities. Fail-open si symbole non
    // mappable (pas censé arriver pour US_CLASSES, mais on est tolérant).
    const tdSymbol = eodhdToTdSymbol(ctx.symbol);
    if (tdSymbol !== null) {
      const st = await ctx.twelveData.getSupertrendSignal(tdSymbol, '30min', 10, 3, 'scanner_us_supertrend');
      if (st !== null && st.direction === 'down') {
        return {
          decision: 'reject_supertrend_down',
          reason: `supertrend direction=down at ${st.timestamp} value=${st.value.toFixed(4)}`,
        };
      }
    }
  }

  // Filtre 2 — RSI crypto 5m overbought
  if (ctx.cryptoRsiEnabled && CRYPTO_CLASSES.has(ctx.assetClass)) {
    const tdSymbol = TwelveDataServiceStaticMapper(ctx.symbol, ctx.twelveData);
    if (tdSymbol !== null) {
      const rsi = await ctx.twelveData.getRsi(tdSymbol, '5min', 14, 'scanner_crypto_rsi');
      if (rsi !== null && rsi.value > RSI_OVERBOUGHT_THRESHOLD) {
        return {
          decision: 'reject_rsi_overbought',
          reason: `RSI ${rsi.value.toFixed(2)} > ${RSI_OVERBOUGHT_THRESHOLD} (overbought) at ${rsi.timestamp}`,
        };
      }
    }
  }

  // Filtre 3 — Supertrend asia equity 30m (PR #360)
  //
  // Contexte 19/05/2026 : asia_equity était la classe la plus saigneuse du jour
  // (-$368 sur 22 positions, WR 18.2%). Hurst exponent (PR S7a) a augmenté le TP
  // ratio asia à 1.30 mais sans filtre de tendance, le scanner accepte des
  // signaux contre-tendance qui se font stopper rapidement. Le filtre Supertrend
  // 30m sur tickers asia (mapping .KO/.KQ → :KRX, .SHG → :SSE, .SHE → :SZSE
  // déjà dans td-symbol-mapper PR #355) rejette les signaux avec tendance baissière
  // confirmée.
  //
  // Fail-open identique au filtre US : null TD ou symbole non-mappable (.T/.HK)
  // → laisse passer.
  if (ctx.asiaSupertrendEnabled && ASIA_CLASSES.has(ctx.assetClass)) {
    const tdSymbol = eodhdToTdSymbol(ctx.symbol);
    if (tdSymbol !== null) {
      const st = await ctx.twelveData.getSupertrendSignal(tdSymbol, '30min', 10, 3, 'scanner_asia_supertrend');
      if (st !== null && st.direction === 'down') {
        return {
          decision: 'reject_supertrend_asia_down',
          reason: `asia supertrend direction=down at ${st.timestamp} value=${st.value.toFixed(4)}`,
        };
      }
    }
  }

  return { decision: 'accept' };
}

/**
 * Helper pour appeler le mapper static depuis le service injecté (le TypeScript
 * d'instance ne voit pas les méthodes static — on accède via la classe).
 */
function TwelveDataServiceStaticMapper(symbol: string, instance: TwelveDataService): string | null {
  const ctor = instance.constructor as unknown as {
    binanceToTwelveDataCrypto?: (pair: string) => string | null;
  };
  if (typeof ctor.binanceToTwelveDataCrypto === 'function') {
    return ctor.binanceToTwelveDataCrypto(symbol);
  }
  return null;
}
