import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * EodhdOptionsService — wrap /api/options/{ticker} pour extraire les
 * signaux de sentiment implicite :
 *
 *  - IV ATM (implied volatility At-The-Money) = prix du risque anticipé.
 *    IV > percentile 80 historique = fear/greed extrême, mean reversion
 *    probable sur la vol.
 *
 *  - Put/Call ratio (volume cumul ATM ± 5% strikes) :
 *    > 1.2 = bearish skew (hedging lourd)
 *    < 0.8 = bullish skew (greed)
 *
 * SCOPE LECTURE SEULE — aucune ouverture d'options, juste signal de
 * sentiment à injecter dans le briefing Lisa. Les protective puts
 * seront une autre itération.
 *
 * Endpoint : GET /api/options/{ticker}?api_token=X&fmt=json
 * Renvoie toutes les chains ; on prend l'expiration la plus proche (front month).
 *
 * Cache 1h — les chains sont mises à jour plusieurs fois par jour mais
 * pas besoin de granularité fine pour un signal de régime.
 */

export interface OptionsSnapshot {
  ticker: string;
  asOf: number;
  expirationDate: string;
  daysToExpiry: number;
  atmIvPct: number | null;
  putCallVolumeRatio: number | null;
  putCallOiRatio: number | null;
  underlyingPrice: number | null;
  skewFlag: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

@Injectable()
export class EodhdOptionsService {
  private readonly logger = new Logger(EodhdOptionsService.name);
  private cache = new Map<string, { snap: OptionsSnapshot; asOf: number }>();
  private readonly CACHE_MS = 60 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  private logCall(row: { ticker: string; success: boolean; statusCode?: number; latencyMs?: number; errorMessage?: string }): void {
    (async () => {
      try {
        await this.supabase.getClient().from('eodhd_request_log').insert({
          ticker: row.ticker,
          eodhd_ticker: row.ticker,
          source: 'eodhd',
          success: row.success,
          status_code: row.statusCode ?? null,
          latency_ms: row.latencyMs ?? null,
          called_by: 'options',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  async getSnapshot(ticker: string): Promise<OptionsSnapshot | null> {
    const cached = this.cache.get(ticker);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.snap;

    const key = this.apiKey();
    if (!key) return null;

    const eodhdTicker = ticker.includes('.') ? ticker : `${ticker}.US`;
    const tStart = Date.now();
    try {
      const url = `https://eodhd.com/api/options/${encodeURIComponent(eodhdTicker)}?api_token=${key}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logCall({ ticker: eodhdTicker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}` });
        return null;
      }
      const body = await res.json() as Record<string, unknown>;
      this.logCall({ ticker: eodhdTicker, success: true, statusCode: res.status, latencyMs });

      const lastTradePrice = Number(body.lastTradePrice ?? body.underlying_price ?? 0);
      const expirations = body.data as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(expirations) || expirations.length === 0) return null;

      // Première expiration (front month)
      const front = expirations[0];
      const expDateStr = String(front.expirationDate ?? '');
      const expDate = new Date(expDateStr).getTime();
      const daysToExpiry = isFinite(expDate)
        ? Math.max(0, Math.round((expDate - Date.now()) / (24 * 60 * 60 * 1000)))
        : 0;

      const options = front.options as Record<string, unknown> | undefined;
      const calls = (options?.CALL as Array<Record<string, unknown>>) || [];
      const puts = (options?.PUT as Array<Record<string, unknown>>) || [];
      if (calls.length === 0 && puts.length === 0) return null;

      // Trouve l'ATM : strike le plus proche du prix spot
      const atmCall = this.findAtm(calls, lastTradePrice);
      const atmPut = this.findAtm(puts, lastTradePrice);
      const atmIvCall = atmCall ? Number(atmCall.impliedVolatility ?? atmCall.implied_volatility ?? 0) : 0;
      const atmIvPut = atmPut ? Number(atmPut.impliedVolatility ?? atmPut.implied_volatility ?? 0) : 0;
      const atmIvRaw = atmIvCall && atmIvPut ? (atmIvCall + atmIvPut) / 2 : atmIvCall || atmIvPut;
      const atmIvPct = atmIvRaw > 0 ? atmIvRaw * 100 : null;

      // Put/call ratio volume ± 5% strikes autour du spot
      const range = lastTradePrice * 0.05;
      const callVol = calls
        .filter((c) => {
          const s = Number(c.strike ?? 0);
          return isFinite(s) && Math.abs(s - lastTradePrice) <= range;
        })
        .reduce((sum, c) => sum + Number(c.volume ?? 0), 0);
      const putVol = puts
        .filter((p) => {
          const s = Number(p.strike ?? 0);
          return isFinite(s) && Math.abs(s - lastTradePrice) <= range;
        })
        .reduce((sum, p) => sum + Number(p.volume ?? 0), 0);

      const callOi = calls
        .filter((c) => {
          const s = Number(c.strike ?? 0);
          return isFinite(s) && Math.abs(s - lastTradePrice) <= range;
        })
        .reduce((sum, c) => sum + Number(c.openInterest ?? c.open_interest ?? 0), 0);
      const putOi = puts
        .filter((p) => {
          const s = Number(p.strike ?? 0);
          return isFinite(s) && Math.abs(s - lastTradePrice) <= range;
        })
        .reduce((sum, p) => sum + Number(p.openInterest ?? p.open_interest ?? 0), 0);

      const putCallVolumeRatio = callVol > 0 ? putVol / callVol : null;
      const putCallOiRatio = callOi > 0 ? putOi / callOi : null;

      let skewFlag: OptionsSnapshot['skewFlag'] = 'NEUTRAL';
      if (putCallVolumeRatio != null) {
        if (putCallVolumeRatio > 1.2) skewFlag = 'BEARISH';
        else if (putCallVolumeRatio < 0.8) skewFlag = 'BULLISH';
      }

      const snap: OptionsSnapshot = {
        ticker,
        asOf: Date.now(),
        expirationDate: expDateStr,
        daysToExpiry,
        atmIvPct,
        putCallVolumeRatio,
        putCallOiRatio,
        underlyingPrice: lastTradePrice || null,
        skewFlag,
      };
      this.cache.set(ticker, { snap, asOf: Date.now() });
      return snap;
    } catch (e) {
      this.logger.warn(`Options ${ticker} failed: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: eodhdTicker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  private findAtm(contracts: Array<Record<string, unknown>>, spot: number): Record<string, unknown> | null {
    if (contracts.length === 0 || !isFinite(spot) || spot <= 0) return null;
    let closest = contracts[0];
    let minDist = Math.abs(Number(closest.strike ?? 0) - spot);
    for (const c of contracts) {
      const s = Number(c.strike ?? 0);
      const d = Math.abs(s - spot);
      if (d < minDist) { minDist = d; closest = c; }
    }
    return closest;
  }

  /** Résumé compact pour le briefing. */
  summarize(snap: OptionsSnapshot | null): string {
    if (!snap) return '';
    const parts: string[] = [snap.ticker];
    if (snap.atmIvPct != null) parts.push(`IV ATM=${snap.atmIvPct.toFixed(1)}%`);
    if (snap.putCallVolumeRatio != null) {
      const flag = snap.skewFlag === 'BULLISH' ? '🟢' : snap.skewFlag === 'BEARISH' ? '🔴' : '⚪';
      parts.push(`P/C vol=${snap.putCallVolumeRatio.toFixed(2)} ${flag}`);
    }
    if (snap.daysToExpiry > 0) parts.push(`${snap.daysToExpiry}dte`);
    return parts.join(' · ');
  }
}
