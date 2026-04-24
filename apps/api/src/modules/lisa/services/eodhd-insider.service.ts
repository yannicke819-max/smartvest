import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * EodhdInsiderService — wrap /api/insider-transactions pour fournir
 * à Lisa les signaux de conviction internes (SEC Form 4).
 *
 * Le pattern le plus prédictif : un C-suite (CEO/CFO/COO) qui achète
 * en open market (pas un vesting automatique) sur son propre titre.
 * C'est un signal fort que Druckenmiller, Soros et Lynch surveillent
 * systématiquement.
 *
 * Endpoint : GET /api/insider-transactions?code={TICKER}.US&api_token=X
 *
 * Cache 6h par ticker — les Form 4 sont publiés en T+2 max, pas besoin
 * de rafraîchir plus souvent.
 */

export interface InsiderTransaction {
  ownerName: string;
  ownerTitle: string;
  date: string;          // YYYY-MM-DD
  transactionCode: string; // P=purchase, S=sale, A=award, M=exercise
  shares: number;
  pricePerShare: number;
  notionalUsd: number;
  acquired: boolean;     // A=acquired, D=disposed
}

export interface InsiderSignal {
  ticker: string;
  asOf: number;
  windowDays: number;
  netBuyUsd: number;      // positif = net buying, négatif = net selling
  csuiteNetBuyUsd: number; // filtré C-suite uniquement
  transactionsCount: number;
  topTransaction: InsiderTransaction | null; // la + grosse en valeur absolue
}

const CSUITE_PATTERN = /(CEO|CFO|COO|CTO|President|Chairman|Chief\s+\w+\s+Officer)/i;

@Injectable()
export class EodhdInsiderService {
  private readonly logger = new Logger(EodhdInsiderService.name);
  private cache = new Map<string, { signal: InsiderSignal; asOf: number }>();
  private readonly CACHE_MS = 6 * 60 * 60 * 1000;

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
          called_by: 'insider',
          error_message: row.errorMessage ?? null,
        });
      } catch { /* swallow */ }
    })();
  }

  /** Récupère et agrège les transactions insider sur les N derniers jours. */
  async getInsiderSignal(ticker: string, windowDays = 30): Promise<InsiderSignal | null> {
    const cacheKey = `${ticker}_${windowDays}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.signal;

    const key = this.apiKey();
    if (!key) return null;

    const eodhdTicker = ticker.includes('.') ? ticker : `${ticker}.US`;
    const tStart = Date.now();
    try {
      const url = `https://eodhd.com/api/insider-transactions?code=${encodeURIComponent(eodhdTicker)}&api_token=${key}&fmt=json&limit=100`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latencyMs = Date.now() - tStart;
      if (!res.ok) {
        this.logCall({ ticker: eodhdTicker, success: false, statusCode: res.status, latencyMs, errorMessage: `HTTP_${res.status}` });
        return null;
      }
      const raw = await res.json() as Array<Record<string, unknown>>;
      this.logCall({ ticker: eodhdTicker, success: true, statusCode: res.status, latencyMs });

      if (!Array.isArray(raw)) return null;

      const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
      const txs: InsiderTransaction[] = raw
        .map((r): InsiderTransaction | null => {
          const dateStr = String(r.transactionDate ?? r.date ?? '');
          if (!dateStr) return null;
          const d = new Date(dateStr).getTime();
          if (!isFinite(d) || d < cutoff) return null;

          const shares = Number(r.transactionAmount ?? 0);
          const price = Number(r.transactionPrice ?? 0);
          if (!isFinite(shares) || !isFinite(price) || shares === 0) return null;

          const acquired = String(r.transactionAcquiredDisposedCode ?? 'A').toUpperCase() === 'A';
          return {
            ownerName: String(r.ownerName ?? 'unknown'),
            ownerTitle: String(r.ownerRelationship ?? r.ownerTitle ?? ''),
            date: dateStr.slice(0, 10),
            transactionCode: String(r.transactionCode ?? '?').toUpperCase(),
            shares,
            pricePerShare: price,
            notionalUsd: shares * price,
            acquired,
          };
        })
        .filter((t): t is InsiderTransaction => t !== null);

      if (txs.length === 0) {
        const empty: InsiderSignal = {
          ticker,
          asOf: Date.now(),
          windowDays,
          netBuyUsd: 0,
          csuiteNetBuyUsd: 0,
          transactionsCount: 0,
          topTransaction: null,
        };
        this.cache.set(cacheKey, { signal: empty, asOf: Date.now() });
        return empty;
      }

      // Agrégation : P (purchase open market) = signal fort ; S (sale) = bearish.
      // A (award) et M (exercise) = bruit (compensation automatique), on ignore.
      const signalTxs = txs.filter((t) => t.transactionCode === 'P' || t.transactionCode === 'S');

      let netBuyUsd = 0;
      let csuiteNetBuyUsd = 0;
      for (const t of signalTxs) {
        const sign = t.transactionCode === 'P' ? 1 : -1;
        netBuyUsd += sign * t.notionalUsd;
        if (CSUITE_PATTERN.test(t.ownerTitle)) {
          csuiteNetBuyUsd += sign * t.notionalUsd;
        }
      }

      const topTransaction = signalTxs.reduce((top, t) => {
        if (!top) return t;
        return Math.abs(t.notionalUsd) > Math.abs(top.notionalUsd) ? t : top;
      }, null as InsiderTransaction | null);

      const signal: InsiderSignal = {
        ticker,
        asOf: Date.now(),
        windowDays,
        netBuyUsd,
        csuiteNetBuyUsd,
        transactionsCount: signalTxs.length,
        topTransaction,
      };
      this.cache.set(cacheKey, { signal, asOf: Date.now() });
      return signal;
    } catch (e) {
      this.logger.warn(`Insider ${ticker} failed: ${String(e).slice(0, 80)}`);
      this.logCall({ ticker: eodhdTicker, success: false, latencyMs: Date.now() - tStart, errorMessage: String(e).slice(0, 200) });
      return null;
    }
  }

  /** Résumé texte compact d'un signal insider pour le briefing. */
  summarize(signal: InsiderSignal | null): string {
    if (!signal || signal.transactionsCount === 0) return '';
    const parts: string[] = [];
    const sign = (n: number) => n >= 0 ? '+' : '';
    const fmt = (n: number) => {
      const abs = Math.abs(n);
      if (abs >= 1e9) return `${sign(n)}${(n / 1e9).toFixed(2)}B$`;
      if (abs >= 1e6) return `${sign(n)}${(n / 1e6).toFixed(2)}M$`;
      if (abs >= 1e3) return `${sign(n)}${(n / 1e3).toFixed(0)}k$`;
      return `${sign(n)}${n.toFixed(0)}$`;
    };
    parts.push(`net=${fmt(signal.netBuyUsd)}`);
    if (signal.csuiteNetBuyUsd !== 0) {
      parts.push(`C-suite=${fmt(signal.csuiteNetBuyUsd)}`);
    }
    if (signal.topTransaction) {
      const t = signal.topTransaction;
      const flag = t.acquired && t.transactionCode === 'P' ? '🟢' : '🔴';
      const title = t.ownerTitle.slice(0, 20);
      parts.push(`top=${flag}${title} ${fmt(t.transactionCode === 'P' ? t.notionalUsd : -t.notionalUsd)}`);
    }
    return `INSIDER(${signal.windowDays}d): ${parts.join(' · ')}`;
  }
}
