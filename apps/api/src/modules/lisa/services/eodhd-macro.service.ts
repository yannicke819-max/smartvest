import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * EodhdMacroService — wrappers autour de /api/macro-indicator/{country}
 * pour fournir à Lisa le contexte macro structurant bien au-delà du
 * simple VIX/DXY.
 *
 * Indicateurs principaux utiles au trading :
 *  - real_interest_rate : taux réel US (= proxy appétit pour le risque)
 *  - inflation_consumer_prices_annual : CPI YoY (surprise → Fed repricing)
 *  - unemployment_total_percent : chômage (signal de cycle)
 *  - gdp_growth_annual : croissance PIB
 *
 * Cache 24h — ces données sont mensuelles/trimestrielles, pas besoin de
 * rafraîchir plus souvent.
 *
 * Endpoint : GET /api/macro-indicator/{country}?indicator={type}&api_token=X
 */

export interface MacroIndicator {
  indicator: string;
  country: string;
  date: string;          // YYYY-MM-DD
  value: number;
  unit: string;
}

export interface MacroContext {
  asOf: number;
  country: string;
  realRate: MacroIndicator | null;
  inflationYoY: MacroIndicator | null;
  unemployment: MacroIndicator | null;
  gdpGrowth: MacroIndicator | null;
}

@Injectable()
export class EodhdMacroService {
  private readonly logger = new Logger(EodhdMacroService.name);
  private cache: Map<string, MacroContext> = new Map();
  private readonly CACHE_MS = 24 * 60 * 60 * 1000;

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
          called_by: 'macro',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  async getMacroContext(country = 'USA'): Promise<MacroContext | null> {
    const cached = this.cache.get(country);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached;

    const key = this.apiKey();
    if (!key) return null;

    const [realRate, inflation, unemp, gdp] = await Promise.all([
      this.fetchIndicator(country, 'real_interest_rate', key),
      this.fetchIndicator(country, 'inflation_consumer_prices_annual', key),
      this.fetchIndicator(country, 'unemployment_total_percent', key),
      this.fetchIndicator(country, 'gdp_growth_annual', key),
    ]);

    const ctx: MacroContext = {
      asOf: Date.now(),
      country,
      realRate,
      inflationYoY: inflation,
      unemployment: unemp,
      gdpGrowth: gdp,
    };
    this.cache.set(country, ctx);
    return ctx;
  }

  private async fetchIndicator(country: string, indicator: string, key: string): Promise<MacroIndicator | null> {
    const ticker = `${country}_${indicator}`;
    const tStart = Date.now();
    try {
      const url = `https://eodhd.com/api/macro-indicator/${encodeURIComponent(country)}?api_token=${key}&fmt=json&indicator=${encodeURIComponent(indicator)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logCall({ ticker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}` });
        return null;
      }
      const data = await res.json() as Array<Record<string, unknown>>;
      this.logCall({ ticker, success: true, statusCode: res.status, latencyMs });

      if (!Array.isArray(data) || data.length === 0) return null;
      // Dernier point daté
      const sorted = [...data].sort((a, b) =>
        new Date(String(b.Date ?? b.date ?? '')).getTime() - new Date(String(a.Date ?? a.date ?? '')).getTime(),
      );
      const latest = sorted[0];
      const value = Number(latest.Value ?? latest.value ?? 0);
      if (!isFinite(value)) return null;

      return {
        indicator,
        country,
        date: String(latest.Date ?? latest.date ?? ''),
        value,
        unit: '%',
      };
    } catch (e) {
      this.logger.warn(`Macro ${indicator} ${country} failed: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /** Résumé texte du contexte macro pour le briefing Lisa. */
  summarize(ctx: MacroContext | null): string {
    if (!ctx) return 'Macro: data unavailable';
    const parts: string[] = [];
    if (ctx.realRate) parts.push(`Real rate=${ctx.realRate.value >= 0 ? '+' : ''}${ctx.realRate.value.toFixed(2)}%`);
    if (ctx.inflationYoY) parts.push(`CPI YoY=${ctx.inflationYoY.value.toFixed(2)}%`);
    if (ctx.unemployment) parts.push(`Unemp=${ctx.unemployment.value.toFixed(2)}%`);
    if (ctx.gdpGrowth) parts.push(`GDP YoY=${ctx.gdpGrowth.value >= 0 ? '+' : ''}${ctx.gdpGrowth.value.toFixed(2)}%`);
    if (parts.length === 0) return 'Macro: data unavailable';
    return `Macro (${ctx.country}): ${parts.join(' · ')}`;
  }
}
