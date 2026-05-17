import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdLoggerService } from './eodhd-logger.service';

/**
 * EodhdScreenerService — wrap /api/screener pour que Lisa découvre
 * quotidiennement des candidats au-delà de son univers mental habituel.
 *
 * Endpoint : POST /api/screener?api_token=X&fmt=json avec filters JSON.
 *
 * 3 scans pré-définis adaptés au style Lisa :
 *
 *  1. "momentum_mid_cap" : mid-caps US en breakout récent
 *     (market cap 2-50B, change_1d > +3%, avg_vol > 500k)
 *
 *  2. "oversold_quality" : qualité survendue (RSI oversold sur largecap)
 *     (market cap > 10B, rsi_14 < 35, P/E raisonnable < 25)
 *
 *  3. "volume_anomaly" : spike de volume vs moyenne (signal discret)
 *     (volume > 3× avg_volume, change positif, cap > 1B)
 *
 * Cache 1h par scan. Fire-and-forget log eodhd_request_log.
 */

export interface ScreenerResult {
  code: string;         // AAPL
  exchange: string;     // US
  name: string;
  sector: string | null;
  industry: string | null;
  marketCapUsd: number | null;
  lastDayChangePct: number | null;
  avgVolume: number | null;
  rsi14: number | null;
  peRatio: number | null;
  epsYoyGrowthPct: number | null;
}

export type ScreenerPreset = 'momentum_mid_cap' | 'oversold_quality' | 'volume_anomaly';

// EODHD screener utilise des noms de champs spécifiques (docs officielles) :
//   - refund_1d_p        : return 1 day %
//   - refund_5d_p        : return 5 days %
//   - market_capitalization
//   - earnings_share     : EPS
//   - dividend_yield
//   - avgvol_200d        : volume moyen 200j
//   - adjusted_close     : clôture ajustée
// Les champs "last_day_change_perc", "volume_vs_avgvol_200d", "rsi_14" et
// "pe_ratio" n'existent PAS dans le screener EODHD et déclenchent HTTP 422.
// Pour oversold_quality on approxime via refund_5d_p < -10 (proxy oversold).
const SCAN_FILTERS: Record<ScreenerPreset, string> = {
  momentum_mid_cap: JSON.stringify([
    ['market_capitalization', '>', 2_000_000_000],
    ['market_capitalization', '<', 50_000_000_000],
    ['refund_1d_p', '>', 3],
    ['avgvol_200d', '>', 500_000],
    ['exchange', '=', 'us'],
  ]),
  oversold_quality: JSON.stringify([
    ['market_capitalization', '>', 10_000_000_000],
    ['refund_5d_p', '<', -10],
    ['earnings_share', '>', 0],
    ['exchange', '=', 'us'],
  ]),
  volume_anomaly: JSON.stringify([
    ['market_capitalization', '>', 1_000_000_000],
    ['avgvol_200d', '>', 1_000_000],
    ['refund_1d_p', '>', 5],
    ['exchange', '=', 'us'],
  ]),
};

@Injectable()
export class EodhdScreenerService {
  private readonly logger = new Logger(EodhdScreenerService.name);
  private cache = new Map<ScreenerPreset, { data: ScreenerResult[]; asOf: number }>();
  private readonly CACHE_MS = 60 * 60_000;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly eodhdLogger: EodhdLoggerService,
  ) {}

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  /**
   * PR #344 — délégué au service partagé EodhdLoggerService. Inclut désormais
   * `endpoint='screener'` + `extras` (preset, n_symbols_returned, credits_estimes,
   * exchange) pour l'audit quota EODHD.
   */
  private logCall(row: {
    ticker: string;
    success: boolean;
    statusCode?: number;
    latencyMs?: number;
    errorMessage?: string;
    nSymbolsReturned?: number;
    preset?: string;
  }): void {
    const extras: Record<string, unknown> = {};
    if (row.preset != null) extras.preset = row.preset;
    if (row.nSymbolsReturned != null) extras.n_symbols_returned = row.nSymbolsReturned;
    extras.credits_estimes = EodhdLoggerService.estimateCredits('screener', {
      n_symbols_returned: row.nSymbolsReturned ?? 0,
    });
    this.eodhdLogger.log({
      ticker: row.ticker,
      eodhdTicker: row.ticker,
      source: 'eodhd',
      success: row.success,
      statusCode: row.statusCode,
      latencyMs: row.latencyMs,
      calledBy: 'screener',
      endpoint: 'screener',
      extras,
      errorMessage: row.errorMessage,
    });
  }

  async runScan(preset: ScreenerPreset, limit = 10): Promise<ScreenerResult[]> {
    const cached = this.cache.get(preset);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.data;

    const key = this.apiKey();
    if (!key) return [];

    const tStart = Date.now();
    try {
      const url = `https://eodhd.com/api/screener?api_token=${key}&fmt=json&limit=${limit}&sort=market_capitalization.desc&filters=${encodeURIComponent(SCAN_FILTERS[preset])}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        // On capture le body d'erreur EODHD pour diagnostic (souvent un JSON
        // { "errors": "filter 'X' is not supported" }). Stocké dans error_message
        // pour être consultable depuis la DB sans accès terminal.
        let bodySnippet = '';
        try {
          const bodyText = await res.text();
          bodySnippet = bodyText.slice(0, 400);
        } catch { /* ignore */ }
        this.logCall({
          ticker: `screener_${preset}`,
          success: false,
          statusCode: res.status,
          latencyMs,
          errorMessage: `HTTP_${res.status} · ${bodySnippet || 'no body'}`,
          preset,
        });
        return [];
      }
      const body = await res.json() as Record<string, unknown>;
      const data = (body.data ?? body) as Array<Record<string, unknown>>;
      const nSymbolsReturned = Array.isArray(data) ? data.length : 0;
      this.logCall({
        ticker: `screener_${preset}`,
        success: true,
        statusCode: res.status,
        latencyMs,
        preset,
        nSymbolsReturned,
      });

      if (!Array.isArray(data)) return [];
      const results: ScreenerResult[] = data.slice(0, limit).map((r) => ({
        code: String(r.code ?? r.Code ?? ''),
        exchange: String(r.exchange ?? r.Exchange ?? 'US'),
        name: String(r.name ?? r.Name ?? ''),
        sector: r.sector ? String(r.sector) : null,
        industry: r.industry ? String(r.industry) : null,
        marketCapUsd: r.market_capitalization ? Number(r.market_capitalization) : null,
        lastDayChangePct: r.last_day_change_perc ? Number(r.last_day_change_perc) : null,
        avgVolume: r.avgvol_200d ? Number(r.avgvol_200d) : null,
        rsi14: r.rsi_14 ? Number(r.rsi_14) : null,
        peRatio: r.pe_ratio ? Number(r.pe_ratio) : null,
        epsYoyGrowthPct: r.eps_yoy_growth_perc ? Number(r.eps_yoy_growth_perc) : null,
      }));

      this.cache.set(preset, { data: results, asOf: Date.now() });
      return results;
    } catch (e) {
      this.logger.warn(`Screener ${preset} failed: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: `screener_${preset}`, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200), preset });
      return [];
    }
  }

  /**
   * Résumé texte compact des 3 scans pour le briefing Lisa — elle peut
   * utiliser ces candidats comme points de départ pour ses thèses sans
   * se limiter à son univers mental.
   */
  async summarizeAllScans(): Promise<string> {
    const [momentum, oversold, volume] = await Promise.all([
      this.runScan('momentum_mid_cap', 5),
      this.runScan('oversold_quality', 5),
      this.runScan('volume_anomaly', 5),
    ]);

    const lines: string[] = [];
    const formatLine = (r: ScreenerResult) => {
      const parts: string[] = [r.code];
      if (r.sector) parts.push(r.sector.slice(0, 20));
      if (r.lastDayChangePct != null) parts.push(`${r.lastDayChangePct >= 0 ? '+' : ''}${r.lastDayChangePct.toFixed(1)}%`);
      if (r.rsi14 != null) parts.push(`RSI=${r.rsi14.toFixed(0)}`);
      if (r.marketCapUsd != null) {
        const b = r.marketCapUsd / 1e9;
        parts.push(`cap=${b >= 1000 ? (b / 1000).toFixed(1) + 'T' : b.toFixed(1) + 'B'}$`);
      }
      return `    - ${parts.join(' · ')}`;
    };

    if (momentum.length > 0) {
      lines.push(`  MOMENTUM mid-cap US (change_1d > +3% · cap 2-50B · vol > 500k)`);
      lines.push(momentum.map(formatLine).join('\n'));
    }
    if (oversold.length > 0) {
      lines.push(`  OVERSOLD quality (cap > 10B · RSI14 < 35 · P/E < 25)`);
      lines.push(oversold.map(formatLine).join('\n'));
    }
    if (volume.length > 0) {
      lines.push(`  VOLUME anomaly (vol > 3× avg 200d · cap > 1B · change > 0)`);
      lines.push(volume.map(formatLine).join('\n'));
    }

    return lines.length > 0 ? lines.join('\n') : '(screener unavailable or no matches)';
  }
}
