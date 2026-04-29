/**
 * P19a — Yahoo Finance intraday vendor (free, no API key, fallback for tickers
 * EODHD doesn't cover at intraday resolution — Korea KOSPI / KOSDAQ small-caps,
 * obscure US small-caps, etc.).
 *
 * Used as **fallback** by `MultiTimeframePersistenceService` when EODHD
 * `getCandles()` returns null or empty. Same shape as EODHD intraday output
 * so the caller can swap providers without re-shaping data.
 *
 * Library : `yahoo-finance2` npm. Rate limit ~2000/h roughly, no auth needed.
 * If Yahoo also returns nothing → caller marks the ticker `coverage:'none'`
 * (UI badge, no skip from worldwide universe scan).
 */

import { Injectable, Logger } from '@nestjs/common';

/**
 * Yahoo-finance2 is published ESM-only. We can't `import` or `require`
 * it from our CJS NestJS bundle, so we lazy-load via dynamic `import()`
 * (works in CJS for ESM modules) and cache the resolved module.
 */
let _yahooFinanceModule: any = null;
async function getYahooFinance(): Promise<any> {
  if (_yahooFinanceModule) return _yahooFinanceModule;
  // ts-ignore : yahoo-finance2 is ESM-only ; with our `node` moduleResolution
  // tsc cannot resolve its type declarations through dynamic `import()`. The
  // runtime resolution works fine (Node walks up `node_modules`).
  // @ts-ignore
  const mod: any = await import('yahoo-finance2');
  _yahooFinanceModule = mod.default ?? mod;
  return _yahooFinanceModule;
}

export interface YahooCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

@Injectable()
export class YahooIntradayService {
  private readonly logger = new Logger(YahooIntradayService.name);

  /**
   * Fetch ~13 candles 5m (1h05) for the given EODHD-style ticker. Internally
   * maps to Yahoo's symbol convention (e.g. `199820.KO` → `199820.KS`).
   * Returns null on any error (timeout, no data, mapping unknown).
   */
  async getCandles(eodhdTicker: string, interval: '5m' | '1m' = '5m'): Promise<YahooCandle[] | null> {
    const yahooSymbol = this.toYahooSymbol(eodhdTicker);
    if (!yahooSymbol) return null;
    try {
      const yahooFinance = await getYahooFinance();
      const period2 = new Date();
      const period1 = new Date(period2.getTime() - 60 * 60 * 1000); // 1h ago
      const result: any = await Promise.race([
        yahooFinance.chart(yahooSymbol, { period1, period2, interval }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('yahoo_timeout')), 8000)),
      ]);
      const quotes = result?.quotes;
      if (!Array.isArray(quotes) || quotes.length === 0) return null;
      const out: YahooCandle[] = [];
      for (const q of quotes) {
        if (!q || q.close == null) continue;
        const date = q.date instanceof Date ? q.date : new Date(q.date);
        if (Number.isNaN(date.getTime())) continue;
        out.push({
          datetime: date.toISOString(),
          open: typeof q.open === 'number' ? q.open : Number(q.close),
          high: typeof q.high === 'number' ? q.high : Number(q.close),
          low: typeof q.low === 'number' ? q.low : Number(q.close),
          close: Number(q.close),
          volume: typeof q.volume === 'number' ? q.volume : 0,
        });
      }
      return out.length > 0 ? out : null;
    } catch (e) {
      this.logger.debug(`[yahoo-intraday] ${eodhdTicker}→${yahooSymbol} error: ${String(e).slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Convert EODHD-style ticker to Yahoo Finance convention.
   * Known mappings :
   *   - AAPL.US     → AAPL          (US, no suffix on Yahoo)
   *   - 7203.T      → 7203.T        (Tokyo, same)
   *   - 0700.HK     → 0700.HK       (HK, same)
   *   - SHEL.LSE    → SHEL.L        (LSE — EODHD uses .LSE, Yahoo uses .L)
   *   - SHEL.L      → SHEL.L        (already Yahoo format)
   *   - SAP.XETRA   → SAP.DE        (XETRA → .DE on Yahoo)
   *   - AIR.PA      → AIR.PA        (Paris, same)
   *   - ASML.AS     → ASML.AS       (AMS, same)
   *   - 199820.KO   → 199820.KS     (KOSPI on Yahoo uses .KS)
   *   - 006340.KO   → 006340.KS
   *   - BHP.AU      → BHP.AX        (ASX on Yahoo uses .AX)
   *   - SHOP.TO     → SHOP.TO       (Toronto, same)
   *   - RELIANCE.NSE→ RELIANCE.NS   (NSE India)
   *   - TCS.BSE     → TCS.BO        (BSE India)
   *
   * Cas non couverts (return null) : crypto (déjà sur Binance), FX, indices.
   */
  toYahooSymbol(eodhdTicker: string): string | null {
    if (!eodhdTicker || typeof eodhdTicker !== 'string') return null;
    const t = eodhdTicker.toUpperCase().trim();
    // No dot = naked ticker, assume Yahoo accepts as-is (rare from our pipeline)
    if (!t.includes('.')) return t;
    const lastDot = t.lastIndexOf('.');
    const base = t.slice(0, lastDot);
    const suffix = t.slice(lastDot + 1);
    switch (suffix) {
      case 'US':    return base;
      case 'T':     return `${base}.T`;
      case 'HK':    return `${base}.HK`;
      case 'L':     return `${base}.L`;
      case 'LSE':   return `${base}.L`;
      case 'PA':    return `${base}.PA`;
      case 'DE':    return `${base}.DE`;
      case 'XETRA': return `${base}.DE`;
      case 'AS':    return `${base}.AS`;
      case 'AMS':   return `${base}.AS`;
      case 'MI':    return `${base}.MI`;
      case 'SW':    return `${base}.SW`;
      case 'MC':    return `${base}.MC`;
      case 'BME':   return `${base}.MC`;
      case 'KO':    return `${base}.KS`;  // KOSPI
      case 'KQ':    return `${base}.KQ`;  // KOSDAQ already Yahoo format
      case 'AU':    return `${base}.AX`;  // ASX
      case 'AX':    return `${base}.AX`;
      case 'TO':    return `${base}.TO`;
      case 'NSE':   return `${base}.NS`;
      case 'BSE':   return `${base}.BO`;
      case 'CC':    return null;          // Crypto — handled by Binance
      case 'FOREX': return null;          // FX — not in scope
      case 'INDX':  return null;          // Indices — not in scope
      case 'COMM':  return null;          // Commodities — not in scope
      default:      return null;          // Unknown suffix
    }
  }
}
