import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwelveDataService } from './twelve-data.service';
import { EodhdIntradayService, type CandleSeries } from './eodhd-intraday.service';

/**
 * PR #352 (original) — Routeur intraday TwelveData-first avec fallback EODHD.
 * PR #353 (cette PR) — Cablage universel + asia mapping + dual-call.
 *
 * Activation :
 *   TWELVEDATA_INTRADAY_SCANNER_ENABLED  bool string  (default false)
 *   TWELVEDATA_INTRADAY_AB_TEST_RATIO    float [0..1] (default 1.0 = 100% TD)
 *
 * Architecture dual-call (PR #353) :
 *   Quand TD est éligible (flag ON + ratio + symbol mappable + pas de
 *   fenêtre historique fromTs/toTs), on appelle EODHD ET TD en parallèle
 *   via Promise.allSettled — pas de fallback séquentiel.
 *
 *   - Préfère TD si retour non vide et valide
 *   - Sinon EODHD comme source de vérité
 *   - EODHD reste TOUJOURS appelé (contrainte user "ZERO offload")
 *   - Log structuré `intraday_router_dual_call` sur chaque appel
 *
 * Branche EODHD-only (pas de TD) si :
 *   - flag OFF / pas de TwelveDataService injecté
 *   - symbol non mappable TD (suffixe inconnu)
 *   - hash % 100 >= ratio*100 (A/B négatif sur ce symbol)
 *   - options.fromTs ou options.toTs présent (TD ne supporte pas time-range
 *     simple dans notre wrapper, historique = EODHD only)
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

export interface IntradayCandlesOptions {
  /** Historical window start (epoch seconds). Si présent → EODHD only. */
  fromTs?: number;
  /** Historical window end (epoch seconds). Si présent → EODHD only. */
  toTs?: number;
  /** Étiquette du caller pour logs Supabase (twelve_data_request_log.called_by). */
  calledBy?: string;
}

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
   * Calcule la raison pour laquelle TD n'est PAS attempted, pour logs.
   * Retourne null si TD doit être tenté (eligible).
   *
   * PR #354 — observabilité distinguant les 3 causes de `td_attempted: false`
   * pour faciliter le diagnostic prod (ex : confondu avec un bug de mapping).
   */
  private computeTdSkipReason(
    eodhdTicker: string,
    hasTimeWindow: boolean,
  ): 'flag_off' | 'td_not_injected' | 'time_window_present' | 'ab_test_sent_to_eodhd' | 'unsupported_suffix' | null {
    if (!this.td) return 'td_not_injected';
    if (
      (this.config.get<string>('TWELVEDATA_INTRADAY_SCANNER_ENABLED') ?? 'false').toLowerCase() !==
      'true'
    ) {
      return 'flag_off';
    }
    if (hasTimeWindow) return 'time_window_present';
    if (!this.shouldRouteToTd(eodhdTicker)) return 'ab_test_sent_to_eodhd';
    if (this.convertToTdSymbol(eodhdTicker) === null) return 'unsupported_suffix';
    return null;
  }

  /**
   * Quote temps réel. Caller passe un ticker EODHD-style (ex `AAPL.US`,
   * `005930.KO`). Dual-call EODHD+TD si éligible.
   */
  async getQuote(eodhdTicker: string, calledBy = 'intraday_router'): Promise<IntradayQuote | null> {
    const tdSkipReason = this.computeTdSkipReason(eodhdTicker, false);
    const tdSymbol = tdSkipReason === null ? this.convertToTdSymbol(eodhdTicker) : null;
    const tdEligible = tdSymbol !== null && this.td !== null;

    const eodhdPromise = this.eodhd.getQuote(eodhdTicker);
    const tdPromise = tdEligible
      ? this.td!.getQuote(tdSymbol!, calledBy)
      : Promise.resolve(null);

    const [eodhdResult, tdResult] = await Promise.allSettled([eodhdPromise, tdPromise]);
    const eodhdVal =
      eodhdResult.status === 'fulfilled' && eodhdResult.value !== null ? eodhdResult.value : null;
    const tdVal =
      tdResult.status === 'fulfilled' && tdResult.value !== null ? tdResult.value : null;

    this.logger.log(
      JSON.stringify({
        event: 'intraday_router_dual_call',
        endpoint: 'quote',
        symbol: eodhdTicker,
        td_symbol: tdSymbol,
        td_attempted: tdEligible,
        td_skip_reason: tdSkipReason, // PR #354 — null si attempted, sinon raison
        td_success: tdVal !== null,
        eodhd_success: eodhdVal !== null,
        called_by: calledBy,
      }),
    );

    if (tdVal !== null) return { ...tdVal, provider: 'td' };
    if (eodhdVal !== null) return { ...eodhdVal, provider: 'eodhd' };
    return null;
  }

  /**
   * Candles intraday au format CandleSeries (compat caller scanner).
   *
   * Branches :
   *   - options.fromTs / options.toTs présents → EODHD only (TD wrapper ne
   *     supporte pas le time-range arbitraire)
   *   - Symbol mappable TD + flag ON + ratio positif → dual-call parallèle,
   *     préférer TD si non vide
   *   - Sinon → EODHD only
   *
   * EODHD est TOUJOURS appelé (contrainte user "ZERO offload").
   */
  async getCandles(
    eodhdTicker: string,
    interval: '1m' | '5m' | '1h' = '1m',
    count = 20,
    options: IntradayCandlesOptions = {},
  ): Promise<IntradayCandleSeries | null> {
    const calledBy = options.calledBy ?? 'intraday_router';
    const hasTimeWindow = options.fromTs != null || options.toTs != null;
    const tdSkipReason = this.computeTdSkipReason(eodhdTicker, hasTimeWindow);
    const tdSymbol = tdSkipReason === null ? this.convertToTdSymbol(eodhdTicker) : null;
    const tdEligible = tdSymbol !== null && this.td !== null;

    const eodhdPromise = this.eodhd.getCandles(
      eodhdTicker,
      interval,
      count,
      hasTimeWindow
        ? {
            ...(options.fromTs != null ? { fromTs: options.fromTs } : {}),
            ...(options.toTs != null ? { toTs: options.toTs } : {}),
          }
        : undefined,
    );
    const tdPromise = tdEligible
      ? this.td!.getCandles(
          tdSymbol!,
          interval === '1m' ? '1min' : interval === '5m' ? '5min' : '1h',
          count,
          calledBy,
        )
      : Promise.resolve(null);

    const [eodhdResult, tdResult] = await Promise.allSettled([eodhdPromise, tdPromise]);
    const eodhdVal =
      eodhdResult.status === 'fulfilled' && eodhdResult.value !== null ? eodhdResult.value : null;
    const tdVal =
      tdResult.status === 'fulfilled' && tdResult.value !== null && tdResult.value.candles.length > 0
        ? tdResult.value
        : null;

    this.logger.log(
      JSON.stringify({
        event: 'intraday_router_dual_call',
        endpoint: 'time_series',
        symbol: eodhdTicker,
        td_symbol: tdSymbol,
        td_attempted: tdEligible,
        td_skip_reason: tdSkipReason, // PR #354 — null si attempted, sinon raison
        td_success: tdVal !== null,
        eodhd_success: eodhdVal !== null,
        interval,
        count,
        time_window: hasTimeWindow,
        called_by: calledBy,
      }),
    );

    if (tdVal !== null) {
      return {
        ticker: eodhdTicker,
        interval,
        candles: tdVal.candles,
        asOf: tdVal.asOf,
        rawCount: tdVal.candles.length,
        provider: 'td',
      };
    }
    if (eodhdVal !== null) return { ...eodhdVal, provider: 'eodhd' };
    return null;
  }

  /**
   * Convertit ticker EODHD → symbol TwelveData.
   *
   * Mapping :
   *   - Sans suffixe                  → ticker tel quel (US)
   *   - .US                           → ticker nu (AAPL.US → AAPL)
   *   - .L / .LSE                     → :LSE (London)
   *   - .PA / .AS / .AMS              → :Euronext (Paris / Amsterdam)
   *   - .XETRA / .DE                  → :XETR (Frankfurt)
   *   - .SW                           → :SIX (Swiss)
   *   - .MI                           → :MIL (Milan)
   *   - .TO                           → :TSX (Toronto)
   *
   * PR #353 — extension asia (76% du trafic intraday actuel) :
   *   - .KO  (KOSPI)                  → :KRX (Korea Exchange)
   *   - .KQ  (KOSDAQ)                 → :KRX
   *   - .SHG (Shanghai SSE)           → :SSE
   *   - .SHE (Shenzhen SZSE)          → :SZSE
   *   - .HK  (Hong Kong)              → :HKEX
   *   - .T   (Tokyo)                  → :XTKS
   *   - .AU  (ASX)                    → :XASX
   *
   * Suffixe inconnu → null → fallback EODHD direct (EODHD reste systématique
   * de toute façon en dual-call).
   *
   * Visible pour tests.
   */
  convertToTdSymbol(eodhdTicker: string): string | null {
    if (!eodhdTicker.includes('.')) return eodhdTicker;
    const [base, suffix] = eodhdTicker.split('.');
    const map: Record<string, string> = {
      US: '',
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
      // PR #353 — asia mapping (TwelveData Pro)
      KO: ':KRX',
      KQ: ':KRX',
      SHG: ':SSE',
      SHE: ':SZSE',
      HK: ':HKEX',
      T: ':XTKS',
      AU: ':XASX',
    };
    if (!(suffix in map)) return null;
    return map[suffix] ? `${base}${map[suffix]}` : base;
  }
}
