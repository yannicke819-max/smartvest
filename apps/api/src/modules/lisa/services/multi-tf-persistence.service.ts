/**
 * P8-MULTI-TIMEFRAME-PERSISTENCE — Service orchestration.
 *
 * Pour un set de candidats top-1m (déjà filtrés par TopGainersScanner) :
 *   - Crypto (Binance) → fetch 1m kline series (60+ candles) → 6 TFs natifs
 *   - Équities (EODHD intraday) → fetch 5m candle series (13 candles) → 5 TFs (1m skip)
 *   - Concurrence cappée à 5 fetches parallèles par source (rate-limit guard)
 *   - Cache 30s par symbole pour absorber les calls UI répétés
 *
 * Out of scope ce PR (deferred) :
 *   - Yahoo finance fallback equities (yfinance non-wired actuellement)
 *   - WebSocket streaming temps réel (REST suffit pour cron 15min + endpoint UI)
 *   - 10m natif (toujours dérivé via 1m ou 5m series)
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  evaluatePersistence,
  evaluateWindowPathQuality,
  extractPricesFromOneMinSeries,
  extractPricesFromFiveMinSeries,
  type PersistenceResult,
  type PathQualityMetrics,
} from '@smartvest/ai-analyst';
import { BinanceMarketService } from './binance-market.service';
import { EodhdIntradayService } from './eodhd-intraday.service';

interface Candidate {
  symbol: string;
  exchange?: string | null;
  currentPrice: number;
}

/**
 * P18e — Marchés EODHD couverts par le plan All-In-One pour intraday 5m.
 * Tout ticker dont l'exchange n'est pas dans cette liste sera skip
 * silencieusement (avec compteur dédié) avant l'appel EODHD — économise
 * les calls et les 422 sur tickers Toronto/India/etc. non supportés en intraday.
 *
 * Source : `EU_EXCHANGES` + `NON_EU_EXCHANGES` de `top-gainers-scanner.service.ts`
 * (P18d), filtré aux exchanges où EODHD fournit des candles 5m.
 */
const SUPPORTED_EQUITY_EXCHANGES = new Set([
  'US',
  'LSE', 'XETRA', 'PA', 'SW', 'MI', 'MC', 'BME', 'AS', 'AMS',
  'TSE', 'HK', 'AU', 'KO',
]);
// TO (Toronto) / NSE / BSE intraday souvent indisponible sur le plan EODHD courant
// → pas dans la whitelist, skip pré-filtré.

/**
 * P9-UX ADDENDUM — Path quality par TF (5/10/15/30/60m), dérivé des candles
 * 1m ou 5m natifs déjà fetchés pour persistence.
 */
export interface PathQualityByTf {
  tf5m: PathQualityMetrics | null;
  tf10m: PathQualityMetrics | null;
  tf15m: PathQualityMetrics | null;
  tf30m: PathQualityMetrics | null;
  tf1h: PathQualityMetrics | null;
  /** Path efficiency moyenne pondérée sur les TFs disponibles. */
  overallEfficiency: number | null;
  /** Smooth si toutes les TFs dispos sont smooth. Choppy si au moins une choppy. */
  overallSmoothness: 'smooth' | 'mixed' | 'choppy' | null;
}

export interface PersistenceWithPath extends PersistenceResult {
  pathQuality?: PathQualityByTf;
}

interface CacheEntry {
  result: PersistenceWithPath;
  asOf: number;
}

const CACHE_TTL_MS = 30_000;
const MAX_PARALLEL_PER_SOURCE = 5;

@Injectable()
export class MultiTimeframePersistenceService {
  private readonly logger = new Logger(MultiTimeframePersistenceService.name);
  private cache = new Map<string, CacheEntry>();

  /** P18e — Compteur cumulatif des tickers sans intraday EODHD (visibilité). */
  private noIntradayCounter = 0;
  /** P18e — Compteur cumulatif des tickers skip pour exchange non supporté. */
  private skippedUnsupportedMarketCounter = 0;

  constructor(
    private readonly binance: BinanceMarketService,
    private readonly eodhd: EodhdIntradayService,
  ) {}

  /** P18e — Métriques cumulatives pour observability. */
  getNoIntradayCounter(): number {
    return this.noIntradayCounter;
  }
  getSkippedUnsupportedMarketCounter(): number {
    return this.skippedUnsupportedMarketCounter;
  }
  /** Reset utilitaire pour tests. */
  resetCounters(): void {
    this.noIntradayCounter = 0;
    this.skippedUnsupportedMarketCounter = 0;
  }

  /**
   * Analyse un seul candidat. Retourne null si les données ne permettent
   * pas de calculer au moins 1 TF.
   */
  async analyze(c: Candidate): Promise<PersistenceWithPath | null> {
    const key = c.symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.asOf < CACHE_TTL_MS) {
      return cached.result;
    }

    const result = await this.fetchAndCompute(c);
    if (result && result.availableCount > 0) {
      this.cache.set(key, { result, asOf: Date.now() });
    }
    return result;
  }

  /**
   * Analyse un batch en parallèle avec cap de concurrence pour respecter
   * les rate-limits (Binance 1200 weight/min, EODHD plan-dependent).
   *
   * Retourne un Map symbol→result. Les symboles sans donnée sont absents.
   *
   * P18e — Pré-filtre les equities dont l'exchange n'est pas dans la
   * whitelist EODHD (compteur `skippedUnsupportedMarketCounter`). Les
   * `null` retournés par `analyze` (no intraday) sont accumulés dans une
   * Set locale puis loggés EN UNE LIGNE en fin de batch — élimine le
   * spam debug par-symbole observé dans les logs Fly 09:14:46–09:15:03 UTC.
   */
  async analyzeBatch(candidates: Candidate[]): Promise<Map<string, PersistenceWithPath>> {
    const out = new Map<string, PersistenceWithPath>();
    if (candidates.length === 0) return out;

    // Split crypto vs equity + pré-filtre exchanges non supportés (P18e)
    const crypto: Candidate[] = [];
    const equity: Candidate[] = [];
    const skippedUnsupported: string[] = [];
    for (const c of candidates) {
      if (this.isCrypto(c)) {
        crypto.push(c);
        continue;
      }
      const ex = String(c.exchange ?? 'US').toUpperCase();
      if (!SUPPORTED_EQUITY_EXCHANGES.has(ex)) {
        this.skippedUnsupportedMarketCounter++;
        skippedUnsupported.push(`${c.symbol}@${ex}`);
        continue;
      }
      equity.push(c);
    }
    if (skippedUnsupported.length > 0) {
      this.logger.debug(
        `[mtf-persist] skipped_unsupported_market: ${skippedUnsupported.length} (sample: ${skippedUnsupported.slice(0, 3).join(', ')})`,
      );
    }

    // Accumule les "no data" symbols pour log agrégé en fin de batch
    const noIntradaySymbols: string[] = [];
    const trackNoData = (c: Candidate) => {
      this.noIntradayCounter++;
      noIntradaySymbols.push(c.symbol);
    };

    await Promise.all([
      this.runWithCap(crypto, MAX_PARALLEL_PER_SOURCE, async (c) => {
        const r = await this.analyzeQuiet(c).catch(() => null);
        if (r) out.set(c.symbol.toUpperCase(), r);
        else trackNoData(c);
      }),
      this.runWithCap(equity, MAX_PARALLEL_PER_SOURCE, async (c) => {
        const r = await this.analyzeQuiet(c).catch(() => null);
        if (r) out.set(c.symbol.toUpperCase(), r);
        else trackNoData(c);
      }),
    ]);

    if (noIntradaySymbols.length > 0) {
      const sample = noIntradaySymbols.slice(0, 5).join(', ');
      this.logger.log(
        `[mtf-persist] no intraday for ${noIntradaySymbols.length} tickers (sample: ${sample})`,
      );
    }

    return out;
  }

  /**
   * P18e — Variante "quiet" de `analyze` sans logs debug par-symbole.
   * Utilisée par `analyzeBatch` qui aggrège les misses en une seule ligne.
   * `analyze()` (single-symbol) reste verbose pour le path UI.
   */
  private async analyzeQuiet(c: Candidate): Promise<PersistenceWithPath | null> {
    const key = c.symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.asOf < CACHE_TTL_MS) {
      return cached.result;
    }
    const result = this.isCrypto(c)
      ? await this.fetchCryptoPersistenceQuiet(c)
      : await this.fetchEquityPersistenceQuiet(c);
    if (result) {
      this.cache.set(key, { result, asOf: Date.now() });
    }
    return result;
  }

  private async fetchCryptoPersistenceQuiet(c: Candidate): Promise<PersistenceWithPath | null> {
    const binSym = this.binance.toBinanceSymbol(c.symbol) ?? c.symbol.toUpperCase();
    const candles = await this.binance.getKlines(binSym, '1m', 61);
    if (!candles || candles.length === 0) return null;
    const prices = extractPricesFromOneMinSeries(candles);
    const persistence = evaluatePersistence(c.currentPrice, prices);
    const pathQuality = computePathQualityForTfsFromOneMin(candles);
    return { ...persistence, pathQuality };
  }

  private async fetchEquityPersistenceQuiet(c: Candidate): Promise<PersistenceWithPath | null> {
    const eodhdTicker = this.toEodhdTicker(c);
    const series = await this.eodhd.getCandles(eodhdTicker, '5m', 13);
    if (!series || series.candles.length === 0) return null;
    const prices = extractPricesFromFiveMinSeries(series.candles);
    const persistence = evaluatePersistence(c.currentPrice, prices);
    const pathQuality = computePathQualityForTfsFromFiveMin(series.candles);
    return { ...persistence, pathQuality };
  }

  // ───────────────────────────────────────────────────────────────────

  private async fetchAndCompute(c: Candidate): Promise<PersistenceWithPath | null> {
    if (this.isCrypto(c)) {
      return this.fetchCryptoPersistence(c);
    }
    return this.fetchEquityPersistence(c);
  }

  private async fetchCryptoPersistence(c: Candidate): Promise<PersistenceWithPath | null> {
    const binSym = this.binance.toBinanceSymbol(c.symbol) ?? c.symbol.toUpperCase();
    // 61 candles 1-min : permet d'avoir l'ouverture il y a 60 minutes
    const candles = await this.binance.getKlines(binSym, '1m', 61);
    if (!candles || candles.length === 0) {
      this.logger.debug(`[mtf-persist] ${c.symbol} no binance klines`);
      return null;
    }
    const prices = extractPricesFromOneMinSeries(candles);
    const persistence = evaluatePersistence(c.currentPrice, prices);
    // Path quality calculé depuis les candles 1m (granularité native)
    const pathQuality = computePathQualityForTfsFromOneMin(candles);
    return { ...persistence, pathQuality };
  }

  private async fetchEquityPersistence(c: Candidate): Promise<PersistenceWithPath | null> {
    // EODHD ticker convention : SYMBOL.EXCHANGE
    const eodhdTicker = this.toEodhdTicker(c);
    // 13 candles 5-min couvre 1h05 — assez pour les TFs 5m..1h
    const series = await this.eodhd.getCandles(eodhdTicker, '5m', 13);
    if (!series || series.candles.length === 0) {
      this.logger.debug(`[mtf-persist] ${c.symbol} no eodhd intraday`);
      return null;
    }
    const prices = extractPricesFromFiveMinSeries(series.candles);
    const persistence = evaluatePersistence(c.currentPrice, prices);
    const pathQuality = computePathQualityForTfsFromFiveMin(series.candles);
    return { ...persistence, pathQuality };
  }

  private isCrypto(c: Candidate): boolean {
    if ((c.exchange ?? '').toUpperCase() === 'BINANCE') return true;
    return /USDT$|USDC$/.test(c.symbol.toUpperCase());
  }

  private toEodhdTicker(c: Candidate): string {
    if (c.symbol.includes('.')) return c.symbol;
    const ex = (c.exchange ?? 'US') ? String(c.exchange ?? 'US').toUpperCase() : 'US';
    return `${c.symbol}.${ex}`;
  }

  /**
   * Exécute une liste de tâches en parallèle avec un cap de concurrence.
   * Retourne quand toutes les tâches sont fulfilled ou rejected.
   */
  private async runWithCap<T>(
    items: T[],
    cap: number,
    task: (item: T) => Promise<unknown>,
  ): Promise<void> {
    if (items.length === 0) return;
    const queue = items.slice();
    const workers: Promise<void>[] = [];
    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        await task(item).catch(() => null);
      }
    };
    const n = Math.min(cap, items.length);
    for (let i = 0; i < n; i++) workers.push(worker());
    await Promise.all(workers);
  }
}

/**
 * P9-UX ADDENDUM — Calcule path quality pour les 5 fenêtres TF
 * (5/10/15/30/60m) à partir d'une série 1-min native (Binance).
 */
function computePathQualityForTfsFromOneMin(
  candles: Array<{ close: number }>,
): PathQualityByTf {
  return summarizePathQuality({
    tf5m: evaluateWindowPathQuality(candles, 5),
    tf10m: evaluateWindowPathQuality(candles, 10),
    tf15m: evaluateWindowPathQuality(candles, 15),
    tf30m: evaluateWindowPathQuality(candles, 30),
    tf1h: evaluateWindowPathQuality(candles, 60),
  });
}

/**
 * Variante 5-min série (EODHD) — windowMinutes converti en nombre de
 * candles 5m via floor(windowMinutes/5).
 */
function computePathQualityForTfsFromFiveMin(
  candles: Array<{ close: number }>,
): PathQualityByTf {
  const tfFromCandles = (windowMin: number): PathQualityMetrics | null => {
    const candlesNeeded = Math.max(1, Math.floor(windowMin / 5));
    return evaluateWindowPathQuality(candles, candlesNeeded);
  };
  return summarizePathQuality({
    tf5m: tfFromCandles(5),
    tf10m: tfFromCandles(10),
    tf15m: tfFromCandles(15),
    tf30m: tfFromCandles(30),
    tf1h: tfFromCandles(60),
  });
}

function summarizePathQuality(byTf: {
  tf5m: PathQualityMetrics | null;
  tf10m: PathQualityMetrics | null;
  tf15m: PathQualityMetrics | null;
  tf30m: PathQualityMetrics | null;
  tf1h: PathQualityMetrics | null;
}): PathQualityByTf {
  const dispos = [byTf.tf5m, byTf.tf10m, byTf.tf15m, byTf.tf30m, byTf.tf1h].filter(
    (m): m is PathQualityMetrics => m !== null,
  );
  const overallEfficiency = dispos.length > 0
    ? dispos.reduce((s, m) => s + m.pathEfficiency, 0) / dispos.length
    : null;
  let overallSmoothness: 'smooth' | 'mixed' | 'choppy' | null = null;
  if (dispos.length > 0) {
    if (dispos.some((m) => m.smoothnessLabel === 'choppy')) overallSmoothness = 'choppy';
    else if (dispos.every((m) => m.smoothnessLabel === 'smooth')) overallSmoothness = 'smooth';
    else overallSmoothness = 'mixed';
  }
  return { ...byTf, overallEfficiency, overallSmoothness };
}
