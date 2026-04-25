import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * EodhdCalendarService — calendrier d'événements corporate (earnings, splits, IPOs).
 *
 * Endpoint : GET https://eodhd.com/api/calendar/earnings
 *   Params : symbols=TICKER1,TICKER2 | from=YYYY-MM-DD | to=YYYY-MM-DD
 *
 * Utile à Lisa pour éviter d'ouvrir des positions equity la veille d'earnings
 * (event binaire, gap risk). Le mechanical-trading.service.ts appelle
 * `getNextEarningsDate(symbol)` avant chaque ouverture pour décider si on
 * filtre ou si on positionne event-driven.
 *
 * Cache : 6h en mémoire (les earnings dates ne bougent pas en intraday).
 * Inclus dans le forfait All-In-One $99 — pas de coût additionnel.
 */

const EARNINGS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface EarningsEntry {
  /** YYYY-MM-DD */
  reportDate: string;
  /** Avant ouverture (BeforeMarket) ou après clôture (AfterMarket) ou null. */
  beforeAfterMarket: string | null;
  estimate: number | null;
  actual: number | null;
}

@Injectable()
export class EodhdCalendarService {
  private readonly logger = new Logger(EodhdCalendarService.name);
  private cache = new Map<string, { earnings: EarningsEntry[]; cachedAt: number }>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Retourne la prochaine date d'earnings pour un ticker, dans la fenêtre
   * [aujourd'hui, aujourd'hui + windowDays]. Null si rien dans la fenêtre.
   *
   * Format ticker : EODHD attend `AAPL.US`, `TSLA.US`. Pour les ETFs/Crypto/FX
   * on retourne null direct (pas d'earnings).
   */
  async getNextEarningsDate(
    symbol: string,
    windowDays: number = 30,
  ): Promise<string | null> {
    if (!this.isEarningsRelevant(symbol)) return null;

    const eodhdTicker = this.toEodhdTicker(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const cached = this.cache.get(eodhdTicker);
    if (cached && Date.now() - cached.cachedAt < EARNINGS_CACHE_TTL_MS) {
      return this.findNextInWindow(cached.earnings, today, windowDays);
    }

    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return null;

    const earnings = await this.fetchEarnings(eodhdTicker, today, windowDays, apiKey);
    this.cache.set(eodhdTicker, { earnings, cachedAt: Date.now() });
    return this.findNextInWindow(earnings, today, windowDays);
  }

  /** Pour vérifier si une thèse est dans la fenêtre dangereuse pré-earnings. */
  async hasEarningsWithinDays(symbol: string, days: number): Promise<boolean> {
    const next = await this.getNextEarningsDate(symbol, days + 7);
    if (!next) return false;
    const daysToEarnings =
      (new Date(next).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysToEarnings >= 0 && daysToEarnings <= days;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /** Crypto, FX, indices, commodities n'ont pas d'earnings — skip. */
  private isEarningsRelevant(symbol: string): boolean {
    const s = symbol.toUpperCase();
    if (s.includes('-USD') || s.includes('USDT') || s.endsWith('.CC')) return false;
    if (s.endsWith('.FOREX') || s.endsWith('.COMM') || s.endsWith('.INDX')) return false;
    if (s === 'BTC' || s === 'ETH' || s === 'SOL' || s === 'BNB') return false;
    if (s.includes('USDJPY') || s.includes('EURUSD') || s.includes('GBPUSD')) return false;
    // Bons ETFs liquides peuvent avoir des "distributions" mais pas earnings
    if (['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'HYG', 'VXX', 'USO', 'IEF', 'UUP', 'EEM', 'FXE', 'FXY'].includes(s)) return false;
    return true;
  }

  private toEodhdTicker(symbol: string): string {
    if (symbol.includes('.')) return symbol;
    return `${symbol.toUpperCase()}.US`;
  }

  private async fetchEarnings(
    eodhdTicker: string,
    fromDate: string,
    windowDays: number,
    apiKey: string,
  ): Promise<EarningsEntry[]> {
    const toDate = new Date(new Date(fromDate).getTime() + windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const url = `https://eodhd.com/api/calendar/earnings?api_token=${apiKey}&fmt=json&symbols=${encodeURIComponent(eodhdTicker)}&from=${fromDate}&to=${toDate}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        this.logger.debug(
          `[earnings-calendar] HTTP ${res.status} for ${eodhdTicker} — assume no earnings`,
        );
        return [];
      }
      const data = (await res.json()) as { earnings?: Array<Record<string, unknown>> };
      const rows = data.earnings ?? [];
      return rows
        .map((r) => ({
          reportDate: String(r['report_date'] ?? r['date'] ?? ''),
          beforeAfterMarket: (r['before_after_market'] as string | null) ?? null,
          estimate:
            r['estimate'] != null && Number.isFinite(Number(r['estimate']))
              ? Number(r['estimate'])
              : null,
          actual:
            r['actual'] != null && Number.isFinite(Number(r['actual']))
              ? Number(r['actual'])
              : null,
        }))
        .filter((e) => e.reportDate);
    } catch (e) {
      this.logger.debug(
        `[earnings-calendar] fetch failed for ${eodhdTicker}: ${String(e).slice(0, 100)}`,
      );
      return [];
    }
  }

  private findNextInWindow(
    earnings: EarningsEntry[],
    fromDate: string,
    windowDays: number,
  ): string | null {
    const cutoff = new Date(new Date(fromDate).getTime() + windowDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const future = earnings
      .filter((e) => e.reportDate >= fromDate && e.reportDate <= cutoff)
      .sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return future.length > 0 ? future[0].reportDate : null;
  }
}
