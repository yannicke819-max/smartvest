import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwelveDataService } from './twelve-data.service';
import { EodhdIntradayService, type CandleSeries } from './eodhd-intraday.service';

/**
 * PR #352 — Routeur intraday TwelveData-first avec fallback EODHD.
 *
 * Activation :
 *   TWELVEDATA_INTRADAY_SCANNER_ENABLED  bool string  (default false)
 *   TWELVEDATA_INTRADAY_AB_TEST_RATIO    float [0..1] (default 1.0 = 100% TD)
 *
 * Routage :
 *   - Flag OFF → 100% EODHD passthrough
 *   - Flag ON  → hash(symbol) % 100 < ratio*100 → TD, sinon EODHD
 *   - TD null   → fallback EODHD obligatoire
 *   - Symbol non mappable TD (asia/HK exotiques) → fallback EODHD direct
 *
 * Fail-safe : si TwelveDataService non injecté (clé absente) OU flag OFF →
 * 100% EODHD. Le router est strictement additif, ne peut pas dégrader le
 * scanner existant.
 *
 * Kill-switch instantané :
 *   flyctl secrets set TWELVEDATA_INTRADAY_SCANNER_ENABLED=false --app smartvest
 */

export interface IntradayQuote {
  price: number;
  changePct: number;
  timestamp: number;
  provider: 'td' | 'eodhd';
}

export type IntradayCandleSeries = CandleSeries & { provider: 'td' | 'eodhd' };

@Injectable()
export class IntradayProviderRouter {
  private readonly logger = new Logger(IntradayProviderRouter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly eodhd: EodhdIntradayService,
    @Optional() private readonly td: TwelveDataService | null = null,
  ) {
    const enabled = this.isEnabled();
    const ratio = this.getRatio();
    this.logger.log(
      `[intraday-router] init enabled=${enabled} ratio=${ratio} td=${this.td ? 'available' : 'unavailable'}`,
    );
  }

  private isEnabled(): boolean {
    if (!this.td) return false;
    return (
      (this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED') ?? 'false').toLowerCase() ===
      'true'
    );
  }

  private getRatio(): number {
    const raw = this.config.get<string>('TWELVEDATA_INTRADAY_AB_TEST_RATIO') ?? '1.0';
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) return 1.0;
    return n;
  }

  /**
   * Hash déterministe FNV-1a (32 bits) → stabilité A/B par symbol :
   * un symbol donné est toujours routé sur le même provider tant que le
   * ratio est inchangé.
   */
  shouldRouteToTd(symbol: string): boolean {
    if (!this.isEnabled()) return false;
    const ratio = this.getRatio();
    if (ratio >= 1.0) return true;
    if (ratio <= 0.0) return false;
    let hash = 2166136261;
    for (let i = 0; i < symbol.length; i++) {
      hash ^= symbol.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash % 100 < ratio * 100;
  }

  /**
   * Quote temps réel. Caller passe un ticker EODHD-style (ex `AAPL.US`,
   * `005930.KO`). Le router convertit pour TD si nécessaire.
   */
  async getQuote(eodhdTicker: string): Promise<IntradayQuote | null> {
    if (this.shouldRouteToTd(eodhdTicker) && this.td) {
      const tdSymbol = this.convertToTdSymbol(eodhdTicker);
      if (tdSymbol !== null) {
        const tdResult = await this.td.getQuote(tdSymbol, 'intraday_router');
        if (tdResult) {
          this.logger.debug(
            `[intraday-router] ${eodhdTicker} provider=td source=primary price=${tdResult.price}`,
          );
          return { ...tdResult, provider: 'td' };
        }
        this.logger.debug(
          `[intraday-router] ${eodhdTicker} provider=td source=fallback (td returned null)`,
        );
      } else {
        this.logger.debug(
          `[intraday-router] ${eodhdTicker} provider=eodhd source=fallback (td unmappable)`,
        );
      }
    }
    const eodhdResult = await this.eodhd.getQuote(eodhdTicker);
    if (!eodhdResult) return null;
    return { ...eodhdResult, provider: 'eodhd' };
  }

  /**
   * Candles intraday au format CandleSeries (compat caller scanner). TD
   * interval mapping : 1m → 1min, 5m → 5min, 1h → 1h.
   */
  async getCandles(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '1m',
    count = 20,
  ): Promise<IntradayCandleSeries | null> {
    if (this.shouldRouteToTd(eodhdTicker) && this.td) {
      const tdSymbol = this.convertToTdSymbol(eodhdTicker);
      if (tdSymbol !== null) {
        const tdInterval = interval === '1m' ? '1min' : interval === '5m' ? '5min' : '1h';
        const tdResult = await this.td.getCandles(tdSymbol, tdInterval, count, 'intraday_router');
        if (tdResult && tdResult.candles.length > 0) {
          this.logger.debug(
            `[intraday-router] ${eodhdTicker} provider=td source=primary candles=${tdResult.candles.length}`,
          );
          return {
            ticker: eodhdTicker,
            interval,
            candles: tdResult.candles,
            asOf: tdResult.asOf,
            rawCount: tdResult.candles.length,
            provider: 'td',
          };
        }
        this.logger.debug(
          `[intraday-router] ${eodhdTicker} provider=td source=fallback (td empty/null)`,
        );
      } else {
        this.logger.debug(
          `[intraday-router] ${eodhdTicker} provider=eodhd source=fallback (td unmappable)`,
        );
      }
    }
    const eodhdResult = await this.eodhd.getCandles(eodhdTicker, interval, count);
    if (!eodhdResult) return null;
    return { ...eodhdResult, provider: 'eodhd' };
  }

  /**
   * Convertit ticker EODHD → symbol TwelveData.
   *   EODHD : AAPL.US, 005930.KO, BMW.XETRA, BNP.PA, BARC.LSE
   *   TD    : AAPL, (asia=null), BMW:XETR, BNP:Euronext, BARC:LSE
   *
   * Conservateur : suffixe asia/HK/AU exotique → null → fallback EODHD direct.
   * Évite signal pourri / symbol non reconnu côté TD.
   *
   * Visible pour tests.
   */
  convertToTdSymbol(eodhdTicker: string): string | null {
    if (!eodhdTicker.includes('.')) return eodhdTicker; // US sans suffixe
    const [base, suffix] = eodhdTicker.split('.');
    const map: Record<string, string> = {
      US: '', // AAPL.US → AAPL
      L: ':LSE',
      LSE: ':LSE',
      PA: ':Euronext',
      AS: ':Euronext',
      AMS: ':Euronext',
      XETRA: ':XETR',
      DE: ':XETR',
      SW: ':SIX',
      MI: ':MIL',
      TO: ':TSX',
    };
    if (!(suffix in map)) return null; // KO/KQ/SHG/SHE/HK/T/AU → fallback EODHD
    return map[suffix] ? `${base}${map[suffix]}` : base;
  }
}
