/**
 * P19a/P19e/P19g — Yahoo Finance intraday vendor (free, no API key, fallback
 * for tickers EODHD doesn't cover at intraday resolution).
 *
 * Used as **fallback** by `MultiTimeframePersistenceService` when EODHD
 * `getCandles()` returns null or empty. Same shape as EODHD intraday output
 * so the caller can swap providers without re-shaping data.
 *
 * ## Historique des fixes
 *
 * - **P19a** (29/04 13h) : introduction du fallback via package
 *   `yahoo-finance2`. Tests passaient mais mockaient le service.
 *
 * - **P19e** (29/04 14h35) : prod observait `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *   Cause : TypeScript `module: CommonJS` transpile `await import(...)` en
 *   `require()`, et le package est ESM-only. Fix : `Function`-bypass dynamic
 *   import (préservait l'ESM `import()` au runtime). L'import passe.
 *
 * - **P19g** (29/04 15h09, ce fichier) : prod observait `yahooFinance.chart
 *   is not a function`. Cause : `yahoo-finance2@2.14.0` est une version
 *   gutted qui n'expose plus que `quote` et `autoc` modules dans son default
 *   export — pas de `chart`, `historical`, etc. Fix : drop complet du package
 *   et appel direct à l'API HTTP publique de Yahoo Finance Chart :
 *
 *     GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
 *         ?interval=5m&range=1h
 *
 *   Endpoint stable (utilisé par finance.yahoo.com lui-même), aucun auth,
 *   nécessite juste un User-Agent réaliste pour ne pas être 403.
 */

import { Injectable, Logger } from '@nestjs/common';

export interface YahooCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Shape of `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}` response.
 * Réduit aux champs qu'on utilise réellement.
 */
interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: { symbol?: string; currency?: string };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * P19g — User-Agent réaliste obligatoire pour éviter Cloudflare 403 sur
 * `query1.finance.yahoo.com`. Le UA Mozilla est utilisé par les SDK Yahoo
 * officieux et n'est pas blacklisté.
 */
const YAHOO_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

/**
 * P19h — Circuit breaker config.
 *
 * Au 1er crash provider Yahoo (HTTP 5xx, 429, 403, parse JSON KO, timeout),
 * on ouvre le circuit pendant `BASE_COOLDOWN_MS`. Backoff exponentiel
 * jusqu'à `MAX_COOLDOWN_MS` si crashes répétés. Reset auto sur succès
 * d'une probe après cooldown.
 *
 * Pendant l'ouverture du circuit :
 *  - 0 spam log (1 seul WARN à l'ouverture, 1 seul LOG à la fermeture)
 *  - getCandles return null silently → MTF service marque coverage='none'
 *  - Pas d'appel HTTP, économie réseau + Yahoo IP plus rate-limited
 *
 * Override env optionnels :
 *  - YAHOO_CIRCUIT_BASE_COOLDOWN_MS (default 60_000 = 60s)
 *  - YAHOO_CIRCUIT_MAX_COOLDOWN_MS  (default 1_800_000 = 30min)
 *  - YAHOO_CIRCUIT_DISABLE          (default false — set 'true' pour désactiver)
 *
 * PR #268 — Bump max cooldown 5min → 30min. Constat prod 07/05/2026 :
 * Yahoo block prolongé (consecutive_failures=414+) → cooldown clampé 5min →
 * 6 retry/heure × ~6 symboles = ~36 calls Yahoo wasted/heure quand le provider
 * est durablement en erreur. À 30 min → ~12 calls wasted/heure (×3 réduction).
 * En cas de back online ponctuel, le probe se fait toujours après 30 min, on
 * récupère le service automatiquement sans intervention.
 */
const DEFAULT_BASE_COOLDOWN_MS = 60_000;       // 60s
const DEFAULT_MAX_COOLDOWN_MS = 1_800_000;     // 30 min

@Injectable()
export class YahooIntradayService {
  private readonly logger = new Logger(YahooIntradayService.name);

  /** P19h — Circuit breaker state. 'closed' = normal, 'open' = skip Yahoo. */
  private circuitState: 'closed' | 'open' = 'closed';
  /** P19h — Wall-clock ms until which the circuit stays open. 0 when closed. */
  private circuitOpenUntilMs = 0;
  /** P19h — Consecutive failures since last success (drives backoff). */
  private consecutiveFailures = 0;
  /** P19h — Cumulative breaker openings (observability). */
  private circuitOpenCount = 0;

  /** P19h — Allow tests / external code to read state. */
  getCircuitStatus(): { state: 'closed' | 'open'; openUntilMs: number; consecutiveFailures: number; openCount: number } {
    return {
      state: this.circuitState,
      openUntilMs: this.circuitOpenUntilMs,
      consecutiveFailures: this.consecutiveFailures,
      openCount: this.circuitOpenCount,
    };
  }

  /** P19h — Test helper / admin reset. Closes the circuit immediately. */
  resetCircuit(): void {
    this.circuitState = 'closed';
    this.circuitOpenUntilMs = 0;
    this.consecutiveFailures = 0;
  }

  /**
   * P19h — Open the circuit with exponential backoff cooldown.
   * 1st failure → 60s, 2nd → 120s, 3rd → 240s, capped at 300s.
   *
   * Log policy : 1 warn par OPEN/REOPEN (typiquement 1 / cooldown cycle, pas
   * du spam per-symbol). `circuitOpenCount` n'incrémente que sur transition
   * closed→open (pas sur reopens consécutifs où le breaker probe a échoué).
   */
  private openCircuit(reason: string): void {
    this.consecutiveFailures += 1;
    const base = DEFAULT_BASE_COOLDOWN_MS;
    const maxC = DEFAULT_MAX_COOLDOWN_MS;
    const cooldownMs = Math.min(base * Math.pow(2, this.consecutiveFailures - 1), maxC);
    const wasClosed = this.circuitState === 'closed';
    this.circuitState = 'open';
    this.circuitOpenUntilMs = Date.now() + cooldownMs;
    if (wasClosed) this.circuitOpenCount += 1;
    // Log à chaque open (rare car gated by cooldown, pas du spam per-call)
    this.logger.warn(
      `[yahoo:circuit] provider disabled for ${Math.round(cooldownMs / 1000)}s due to ${reason} (consecutive_failures=${this.consecutiveFailures})`,
    );
  }

  /** P19h — Close circuit on success, reset failures counter. */
  private closeCircuitOnSuccess(): void {
    if (this.circuitState === 'open' || this.consecutiveFailures > 0) {
      this.logger.log(
        `[yahoo:circuit] provider re-enabled after probe success (was ${this.consecutiveFailures} consecutive failures)`,
      );
    }
    this.circuitState = 'closed';
    this.circuitOpenUntilMs = 0;
    this.consecutiveFailures = 0;
  }

  /**
   * Fetch ~13 candles 5m (1h05) for the given EODHD-style ticker. Internally
   * maps to Yahoo's symbol convention (e.g. `199820.KO` → `199820.KS`).
   * Returns null on any error (timeout, no data, mapping unknown).
   *
   * P19h — Circuit breaker : si le circuit est ouvert et qu'on n'a pas encore
   * passé `circuitOpenUntilMs`, retourne null silently sans toucher à fetch().
   * Quand le cooldown est passé, le call passe (mode "half-open" probe) ;
   * succès → close circuit, échec → re-open avec backoff exponentiel.
   */
  async getCandles(eodhdTicker: string, interval: '5m' | '1m' = '5m'): Promise<YahooCandle[] | null> {
    const yahooSymbol = this.toYahooSymbol(eodhdTicker);
    if (!yahooSymbol) return null;

    // P19h — Circuit open + cooldown actif → return null silently (no log spam)
    if (this.circuitState === 'open' && Date.now() < this.circuitOpenUntilMs) {
      return null;
    }

    // Yahoo accepte interval = 1m / 2m / 5m / 15m / 30m / 60m / 90m / 1h / 1d / ...
    // range = 1d / 5d / 1mo / ... — pour 1h de data on prend 5d (Yahoo cap minimum,
    // sera tronqué au 60 dernières candles côté caller).
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=1d`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': YAHOO_USER_AGENT,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        // P19h — Specific HTTP statuses that indicate provider-level failure
        // (vs ticker-not-found which is just 404 and should NOT trip breaker)
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          this.openCircuit(`HTTP ${res.status}`);
        } else {
          this.logger.debug(
            `[yahoo-intraday] ${eodhdTicker}→${yahooSymbol} HTTP ${res.status}`,
          );
        }
        return null;
      }

      const json = (await res.json()) as YahooChartResponse;

      // Path Yahoo : json.chart.result[0]
      const chartErr = json?.chart?.error;
      if (chartErr) {
        // chart.error = symbol not found in Yahoo; ne pas tripper le breaker
        // (provider OK, ticker unknown). Retour null silently.
        return null;
      }
      const result = json?.chart?.result?.[0];
      if (!result) return null;
      const timestamps = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0];
      if (!quote || timestamps.length === 0) return null;

      const opens = quote.open ?? [];
      const highs = quote.high ?? [];
      const lows = quote.low ?? [];
      const closes = quote.close ?? [];
      const volumes = quote.volume ?? [];

      const out: YahooCandle[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (close == null || !Number.isFinite(close)) continue;
        const ts = timestamps[i];
        if (!Number.isFinite(ts)) continue;
        const open = typeof opens[i] === 'number' ? (opens[i] as number) : close;
        const high = typeof highs[i] === 'number' ? (highs[i] as number) : close;
        const low = typeof lows[i] === 'number' ? (lows[i] as number) : close;
        const volume = typeof volumes[i] === 'number' ? (volumes[i] as number) : 0;
        out.push({
          datetime: new Date(ts * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume,
        });
      }
      // P19h — Successful response → close breaker, reset failures counter
      this.closeCircuitOnSuccess();
      return out.length > 0 ? out : null;
    } catch (e) {
      // P19h — Network error / timeout / abort / parse → trip breaker
      this.openCircuit(`fetch error: ${String(e).slice(0, 60)}`);
      return null;
    }
  }

  /**
   * Convert EODHD-style ticker to Yahoo Finance convention.
   * Known mappings (cf. p19g preserved from p19a) :
   *   - AAPL.US     → AAPL
   *   - 7203.T      → 7203.T
   *   - 0700.HK     → 0700.HK
   *   - SHEL.LSE    → SHEL.L
   *   - SHEL.L      → SHEL.L
   *   - SAP.XETRA   → SAP.DE
   *   - AIR.PA      → AIR.PA
   *   - ASML.AS     → ASML.AS
   *   - 199820.KO   → 199820.KS  (KOSPI)
   *   - BHP.AU      → BHP.AX     (ASX)
   *   - SHOP.TO     → SHOP.TO
   *   - RELIANCE.NSE→ RELIANCE.NS
   *   - TCS.BSE     → TCS.BO
   *   - 600000.SS   → 600000.SS  (Shanghai)
   *   - 000001.SZ   → 000001.SZ  (Shenzhen)
   *
   * Cas non couverts (return null) : crypto (déjà sur Binance), FX, indices.
   */
  toYahooSymbol(eodhdTicker: string): string | null {
    if (!eodhdTicker || typeof eodhdTicker !== 'string') return null;
    const t = eodhdTicker.toUpperCase().trim();
    if (!t.includes('.')) return t;
    const lastDot = t.lastIndexOf('.');
    const base = t.slice(0, lastDot);
    const suffix = t.slice(lastDot + 1);
    switch (suffix) {
      case 'US':    return base;
      case 'T':     return `${base}.T`;
      case 'HK':    return `${base}.HK`;
      case 'L':     return `${base}.L`;
      case 'LSE':   return `${base}.L`;
      case 'PA':    return `${base}.PA`;
      case 'DE':    return `${base}.DE`;
      case 'XETRA': return `${base}.DE`;
      case 'AS':    return `${base}.AS`;
      case 'AMS':   return `${base}.AS`;
      case 'MI':    return `${base}.MI`;
      case 'SW':    return `${base}.SW`;
      case 'MC':    return `${base}.MC`;
      case 'BME':   return `${base}.MC`;
      case 'KO':    return `${base}.KS`;
      case 'KQ':    return `${base}.KQ`;
      case 'AU':    return `${base}.AX`;
      case 'AX':    return `${base}.AX`;
      case 'TO':    return `${base}.TO`;
      case 'NSE':   return `${base}.NS`;
      case 'BSE':   return `${base}.BO`;
      case 'SS':    return `${base}.SS`;
      case 'SZ':    return `${base}.SZ`;
      case 'CC':    return null;
      case 'FOREX': return null;
      case 'INDX':  return null;
      case 'COMM':  return null;
      default:      return null;
    }
  }
}
