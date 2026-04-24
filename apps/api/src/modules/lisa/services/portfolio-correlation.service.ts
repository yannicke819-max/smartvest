import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * PortfolioCorrelationService — calcule les corrélations pairwise entre
 * positions et vs un benchmark (SPY) à partir des clôtures EOD.
 *
 * Utilisé par :
 *  - P4.2 — rejet d'ouverture si corrélation avec une position existante
 *    > seuil (default 0.7). Évite la concentration cachée : ex. ouvrir
 *    NVDA quand on a déjà AMD et MSFT = 1 cluster tech, pas 3 positions.
 *  - P4.4 — détection regime correlation shock : si la moyenne des
 *    corrélations positions ↔ SPY dépasse 0.85, on est en crisis mode
 *    (toutes les corrélations convergent vers 1 en 2008, mars 2020, 2022).
 *    → on bloque les ouvertures ce cycle.
 *
 * Endpoint : GET /api/eod/{ticker}?from=YYYY-MM-DD&to=YYYY-MM-DD&fmt=json
 * Cache 24h par ticker (EOD ne change pas en intraday).
 */

@Injectable()
export class PortfolioCorrelationService {
  private readonly logger = new Logger(PortfolioCorrelationService.name);
  private cache = new Map<string, { returns: Map<string, number>; asOf: number }>();
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
          called_by: 'correlation',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  /**
   * Récupère les retours journaliers d'un ticker sur N jours calendaires.
   * Retourne une Map<dateISO, returnPct> pour pouvoir calculer une
   * corrélation sur dates communes avec un autre ticker.
   */
  private async getDailyReturns(eodhdTicker: string, days: number): Promise<Map<string, number> | null> {
    const cached = this.cache.get(eodhdTicker);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) {
      return cached.returns;
    }

    const key = this.apiKey();
    if (!key) return null;

    const to = new Date();
    const from = new Date(Date.now() - days * 86_400_000);
    const toStr = to.toISOString().slice(0, 10);
    const fromStr = from.toISOString().slice(0, 10);

    const tStart = Date.now();
    try {
      const url = `https://eodhd.com/api/eod/${encodeURIComponent(eodhdTicker)}?from=${fromStr}&to=${toStr}&api_token=${encodeURIComponent(key)}&fmt=json&order=a`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logCall({ ticker: eodhdTicker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}` });
        return null;
      }
      const data = await res.json() as Array<{ date?: string; close?: number; adjusted_close?: number }>;
      this.logCall({ ticker: eodhdTicker, success: true, statusCode: res.status, latencyMs });

      if (!Array.isArray(data) || data.length < 2) return null;

      // On travaille sur adjusted_close si dispo, close sinon (plus robuste
      // aux splits/dividendes qui biaiseraient artificiellement un return)
      const returns = new Map<string, number>();
      for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1].adjusted_close ?? data[i - 1].close;
        const curr = data[i].adjusted_close ?? data[i].close;
        const d = data[i].date;
        if (typeof prev === 'number' && typeof curr === 'number' && typeof d === 'string' && prev > 0) {
          returns.set(d, (curr - prev) / prev);
        }
      }

      this.cache.set(eodhdTicker, { returns, asOf: Date.now() });
      return returns;
    } catch (e) {
      this.logger.warn(`EOD fetch failed for ${eodhdTicker}: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: eodhdTicker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /**
   * Coefficient de corrélation de Pearson entre deux séries de retours,
   * calculé uniquement sur les dates communes aux deux séries.
   * Retourne null si moins de 10 dates communes (échantillon trop petit).
   */
  private pearson(a: Map<string, number>, b: Map<string, number>): number | null {
    const commonDates: string[] = [];
    for (const d of a.keys()) if (b.has(d)) commonDates.push(d);
    if (commonDates.length < 10) return null;

    const xs = commonDates.map((d) => a.get(d) as number);
    const ys = commonDates.map((d) => b.get(d) as number);
    const n = xs.length;
    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    if (den === 0) return null;
    return num / den;
  }

  /**
   * Corrélation pairwise entre 2 tickers sur N jours.
   * Retourne null si data indispo ou échantillon < 10 jours communs.
   */
  async pairwise(eodhdTickerA: string, eodhdTickerB: string, days = 30): Promise<number | null> {
    const [a, b] = await Promise.all([
      this.getDailyReturns(eodhdTickerA, days),
      this.getDailyReturns(eodhdTickerB, days),
    ]);
    if (!a || !b) return null;
    return this.pearson(a, b);
  }

  /**
   * Corrélation max d'un nouveau ticker avec chaque ticker existant.
   * Utilisé pour filtrer les nouvelles ouvertures trop corrélées (P4.2).
   */
  async getMaxCorrelationAgainst(
    newEodhdTicker: string,
    existingEodhdTickers: string[],
    days = 30,
  ): Promise<{ max: number | null; withTicker: string | null }> {
    if (existingEodhdTickers.length === 0) return { max: null, withTicker: null };
    const results = await Promise.all(
      existingEodhdTickers.map((t) => this.pairwise(newEodhdTicker, t, days).then((corr) => ({ t, corr }))),
    );
    let maxCorr = -Infinity;
    let withTicker: string | null = null;
    for (const { t, corr } of results) {
      if (corr != null && corr > maxCorr) {
        maxCorr = corr;
        withTicker = t;
      }
    }
    return { max: maxCorr === -Infinity ? null : maxCorr, withTicker };
  }

  /**
   * Corrélation moyenne d'une liste de tickers avec un benchmark (default SPY).
   * Si > 0.85, on est en régime "correlation goes to 1 in crisis" (P4.4).
   */
  async getAvgCorrelationWithBenchmark(
    eodhdTickers: string[],
    benchmarkEodhdTicker = 'SPY.US',
    days = 30,
  ): Promise<{ avg: number | null; n: number }> {
    if (eodhdTickers.length === 0) return { avg: null, n: 0 };
    const results = await Promise.all(
      eodhdTickers.map((t) => this.pairwise(t, benchmarkEodhdTicker, days)),
    );
    const valid = results.filter((c): c is number => c != null);
    if (valid.length === 0) return { avg: null, n: 0 };
    const avg = valid.reduce((s, v) => s + v, 0) / valid.length;
    return { avg, n: valid.length };
  }
}
