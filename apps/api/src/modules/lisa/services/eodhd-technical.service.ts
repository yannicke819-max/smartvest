import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * EodhdTechnicalService — wrapper autour de /api/technical d'EODHD pour
 * fournir à Lisa et à l'agent mécanique les indicateurs techniques dont
 * ils ont besoin pour prendre des décisions confirmées (pas à l'aveugle).
 *
 * Endpoints utilisés :
 *   GET /api/technical/{ticker}?function=rsi&period=14
 *   GET /api/technical/{ticker}?function=macd
 *   GET /api/technical/{ticker}?function=atr&period=14
 *   GET /api/technical/{ticker}?function=bbands&period=20
 *
 * Cache 5 min (les indicateurs EOD ne changent pas en intraday avant
 * clôture). Fire-and-forget logging dans eodhd_request_log.
 */

export interface TechnicalIndicators {
  ticker: string;
  asOf: string;
  rsi14: number | null;               // 0-100, < 30 = oversold, > 70 = overbought
  macd: number | null;                // MACD line
  macdSignal: number | null;          // Signal line
  macdHist: number | null;            // Histogram (momentum)
  atr14: number | null;               // Average True Range (volatilité absolue)
  atr14Pct: number | null;            // ATR en % du prix (pour stops dynamiques)
  bbUpper: number | null;             // Bollinger upper band
  bbMiddle: number | null;            // Bollinger middle (SMA20)
  bbLower: number | null;             // Bollinger lower band
  bbPctB: number | null;              // Position du prix dans la bande (0 = bottom, 1 = top)
}

@Injectable()
export class EodhdTechnicalService {
  private readonly logger = new Logger(EodhdTechnicalService.name);
  private cache = new Map<string, { data: TechnicalIndicators; asOf: number }>();
  private readonly CACHE_MS = 5 * 60 * 1000;

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
          called_by: 'technical',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  /**
   * Fetch les 4 indicateurs principaux en parallèle pour un ticker.
   * Retourne un objet avec null aux champs indisponibles.
   */
  async getIndicators(eodhdTicker: string, currentPrice?: number): Promise<TechnicalIndicators> {
    const cached = this.cache.get(eodhdTicker);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) {
      return cached.data;
    }

    const key = this.apiKey();
    const now = new Date().toISOString();
    const empty: TechnicalIndicators = {
      ticker: eodhdTicker, asOf: now,
      rsi14: null, macd: null, macdSignal: null, macdHist: null,
      atr14: null, atr14Pct: null, bbUpper: null, bbMiddle: null, bbLower: null, bbPctB: null,
    };

    if (!key) return empty;

    // Fetch les 4 indicateurs en parallèle
    const [rsi, macd, atr, bb] = await Promise.all([
      this.fetchIndicator(eodhdTicker, 'rsi', { period: 14 }, key),
      this.fetchIndicator(eodhdTicker, 'macd', {}, key),
      this.fetchIndicator(eodhdTicker, 'atr', { period: 14 }, key),
      this.fetchIndicator(eodhdTicker, 'bbands', { period: 20 }, key),
    ]);

    // Parse les réponses — chaque indicateur retourne un array de points,
    // on prend le plus récent
    const rsiLast = rsi?.[rsi.length - 1];
    const macdLast = macd?.[macd.length - 1];
    const atrLast = atr?.[atr.length - 1];
    const bbLast = bb?.[bb.length - 1];

    const atr14 = atrLast && typeof atrLast.atr === 'number' ? atrLast.atr : null;
    const atr14Pct = atr14 != null && currentPrice != null && currentPrice > 0
      ? (atr14 / currentPrice) * 100
      : null;

    const bbUpper = bbLast && typeof bbLast.uband === 'number' ? bbLast.uband : null;
    const bbMiddle = bbLast && typeof bbLast.mband === 'number' ? bbLast.mband : null;
    const bbLower = bbLast && typeof bbLast.lband === 'number' ? bbLast.lband : null;
    const bbPctB = bbUpper != null && bbLower != null && currentPrice != null && bbUpper !== bbLower
      ? (currentPrice - bbLower) / (bbUpper - bbLower)
      : null;

    const result: TechnicalIndicators = {
      ticker: eodhdTicker,
      asOf: now,
      rsi14: rsiLast && typeof rsiLast.rsi === 'number' ? rsiLast.rsi : null,
      macd: macdLast && typeof macdLast.macd === 'number' ? macdLast.macd : null,
      macdSignal: macdLast && typeof macdLast.signal === 'number' ? macdLast.signal : null,
      macdHist: macdLast && typeof macdLast.divergence === 'number' ? macdLast.divergence : null,
      atr14, atr14Pct,
      bbUpper, bbMiddle, bbLower, bbPctB,
    };

    this.cache.set(eodhdTicker, { data: result, asOf: Date.now() });
    return result;
  }

  private async fetchIndicator(
    ticker: string,
    fn: string,
    params: Record<string, string | number>,
    key: string,
  ): Promise<Array<Record<string, unknown>> | null> {
    const tStart = Date.now();
    try {
      const qs = new URLSearchParams({
        api_token: key,
        fmt: 'json',
        function: fn,
        order: 'a',
        ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      }).toString();
      const url = `https://eodhd.com/api/technical/${encodeURIComponent(ticker)}?${qs}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logCall({ ticker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}_${fn}` });
        return null;
      }
      const data = await res.json() as Array<Record<string, unknown>>;
      this.logCall({ ticker, success: true, statusCode: res.status, latencyMs });
      return Array.isArray(data) ? data : null;
    } catch (e) {
      this.logger.warn(`Technical ${fn} failed for ${ticker}: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /**
   * Helper : interprétation humaine pour injection dans les prompts Lisa.
   * Génère une ligne de résumé compact pour le bloc MISSION.
   */
  summarize(ind: TechnicalIndicators): string {
    const parts: string[] = [];
    if (ind.rsi14 != null) {
      const tag = ind.rsi14 < 30 ? ' (oversold)' : ind.rsi14 > 70 ? ' (overbought)' : '';
      parts.push(`RSI14=${ind.rsi14.toFixed(1)}${tag}`);
    }
    if (ind.macdHist != null) {
      parts.push(`MACD_hist=${ind.macdHist >= 0 ? '+' : ''}${ind.macdHist.toFixed(3)} (${ind.macdHist >= 0 ? 'bullish' : 'bearish'} momentum)`);
    }
    if (ind.atr14Pct != null) {
      parts.push(`ATR14=${ind.atr14Pct.toFixed(2)}%`);
    }
    if (ind.bbPctB != null) {
      const tag = ind.bbPctB > 1 ? ' (above upper)' : ind.bbPctB < 0 ? ' (below lower)' : '';
      parts.push(`BB_%B=${ind.bbPctB.toFixed(2)}${tag}`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'indicators unavailable';
  }
}
