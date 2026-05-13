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
 * P19g (avant Bug #C) — Un seul User-Agent fixe (Chrome 120 Linux x86_64).
 * P19k / Bug #C (13/05/2026) — Pool de 4 UAs validés 200 OK + rotation
 * round-robin par appel + single-shot retry sur 429.
 *
 * Diagnostic : depuis le 7 mai 2026 (commit 22e276b PR #268), 100% des
 * requêtes prod Yahoo retournent 429. Tests empiriques agent depuis sandbox
 * datacenter (IP 34.19.49.124, le 13/05/2026) :
 *   - Chrome 120 Linux x86_64 (prod actuel)  → 429 banni
 *   - Chrome 131 Mac                          → 429 banni
 *   - Firefox 121 Mac                         → 429 banni
 *   - Chrome 124 Windows NT 10.0              → 200 OK
 *   - Chrome 126 Windows NT 10.0              → 200 OK
 *   - iPhone Safari iOS 17                    → 200 OK
 *   - Googlebot/2.1                           → 200 OK
 *
 * Ce n'est PAS un problème d'IP datacenter (mêmes IPs, UA différents =
 * comportements différents). Yahoo maintient une blocklist UA statique sur
 * les patterns "dev bot common" (Linux x86_64, Firefox Mac, Chrome Mac avec
 * dernière version).
 *
 * Impact prod (SQL gainers_user_shadow_signals 24h) : 1026 signaux passent
 * par step yahoo_intraday_5m → tous null → tous OFF_SESSION. Yahoo en
 * PRIMAIRE dans multi-tf-persistence ET en fallback dans simulator → cascade
 * vers EODHD aggrave Bug #H/#I.
 *
 * UAs bannis statiquement par Yahoo le 13/05/2026 (NE PAS RÉINTRODUIRE) :
 *   - Chrome Linux x86_64 (toutes versions ≥ 120)
 *   - Chrome 131 Mac
 *   - Firefox 121 Mac
 *
 * Retry single-shot sur 429 : avec rotation UA, un 429 isolé n'est plus
 * représentatif d'une panne provider — c'est souvent un UA particulier qui
 * vient d'être banni. On retry une fois avec l'UA suivant avant de tripper
 * le circuit breaker. Sur 403/5xx (sans 429), comportement P19h inchangé
 * (open circuit immédiat).
 */
const YAHOO_USER_AGENTS: ReadonlyArray<string> = [
  // Chrome 124 Windows NT 10.0 — validé 200 OK 13/05/2026
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Chrome 126 Windows NT 10.0 — validé 200 OK 13/05/2026
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // iPhone Safari iOS 17.0 — validé 200 OK 13/05/2026
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  // iPhone Safari iOS 17.2 — validé 200 OK 13/05/2026
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
];

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
// P19k / Bug #C — Réduit 60s → 15s. Avec rotation UA + single-shot retry, un
// 429 isolé n'est plus représentatif d'une panne provider. Backoff exp 15s
// → 30s → 60s → ... → 30min reste protecteur. Sur panne réelle, on atteint
// la cap 30min après ~7 échecs consécutifs (vs ~5 pré-Bug #C, ~+30s).
const DEFAULT_BASE_COOLDOWN_MS = 15_000;       // 15s (était 60s avant Bug #C)
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
  /**
   * P19k / Bug #C — Index round-robin pour rotation User-Agent. Incrémenté
   * à chaque sélection d'UA dans getCandles (call principal + retry 429).
   */
  private uaIndex = 0;

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

    // P19k / Bug #C — Attempt 1 avec UA rotaté.
    const ua1 = YAHOO_USER_AGENTS[this.uaIndex++ % YAHOO_USER_AGENTS.length];
    const attempt1 = await this.fetchAttempt(url, ua1, eodhdTicker, yahooSymbol);

    if (attempt1.kind === 'ok') {
      this.closeCircuitOnSuccess();
      return attempt1.candles;
    }
    if (attempt1.kind === 'silent_null') {
      return null;
    }
    if (attempt1.kind === 'open_circuit') {
      // 403 / 5xx / fetch_error sur premier appel → open immédiat (P19h inchangé).
      this.openCircuit(attempt1.reason);
      return null;
    }
    // attempt1.kind === 'retry_on_429' — P19k / Bug #C single-shot retry avec UA suivant.
    const ua2 = YAHOO_USER_AGENTS[this.uaIndex++ % YAHOO_USER_AGENTS.length];
    const attempt2 = await this.fetchAttempt(url, ua2, eodhdTicker, yahooSymbol);

    if (attempt2.kind === 'ok') {
      this.closeCircuitOnSuccess();
      return attempt2.candles;
    }
    if (attempt2.kind === 'silent_null') {
      // Retry returned 404 / chart.error / empty payload → ticker unknown, pas d'open.
      return null;
    }
    // attempt2.kind in {'retry_on_429', 'open_circuit'} — la retry a échoué, on
    // ouvre le breaker avec la raison Bug #C explicite (peu importe que ce soit
    // 429 récidive, 403, 5xx, ou network error : on a déjà retry le coup UA).
    this.openCircuit('HTTP 429 after UA rotation retry');
    return null;
  }

  /**
   * P19k / Bug #C — Tentative unique de fetch + parse. Séparée de getCandles
   * pour permettre la rotation UA + retry single-shot sans duplication de logic.
   *
   * Retourne un discriminated union pour que getCandles décide quoi faire :
   *   - 'ok'              : 200 + payload valide → success path
   *   - 'silent_null'     : 404, chart.error, empty payload → null sans trip
   *   - 'retry_on_429'    : 429 spécifique → caller peut retry avec next UA
   *   - 'open_circuit'    : 403 / 5xx / fetch_error → caller doit open circuit
   */
  private async fetchAttempt(
    url: string,
    userAgent: string,
    eodhdTicker: string,
    yahooSymbol: string,
  ): Promise<
    | { kind: 'ok'; candles: YahooCandle[] }
    | { kind: 'silent_null' }
    | { kind: 'retry_on_429' }
    | { kind: 'open_circuit'; reason: string }
  > {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        if (res.status === 429) {
          // P19k / Bug #C — 429 isolé : caller peut tenter retry avec autre UA.
          return { kind: 'retry_on_429' };
        }
        if (res.status === 403 || res.status >= 500) {
          // P19h — 403 / 5xx : panne provider claire, open circuit immédiat.
          return { kind: 'open_circuit', reason: `HTTP ${res.status}` };
        }
        // Autres 4xx (404, etc.) : ticker unknown, silent null.
        this.logger.debug(
          `[yahoo-intraday] ${eodhdTicker}→${yahooSymbol} HTTP ${res.status}`,
        );
        return { kind: 'silent_null' };
      }

      const json = (await res.json()) as YahooChartResponse;

      const chartErr = json?.chart?.error;
      if (chartErr) {
        // chart.error = symbol not found in Yahoo; ne pas tripper le breaker.
        return { kind: 'silent_null' };
      }
      const result = json?.chart?.result?.[0];
      if (!result) return { kind: 'silent_null' };
      const timestamps = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0];
      if (!quote || timestamps.length === 0) return { kind: 'silent_null' };

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
      return out.length > 0
        ? { kind: 'ok', candles: out }
        : { kind: 'silent_null' };
    } catch (e) {
      // P19h — Network error / timeout / abort / parse → open circuit.
      return { kind: 'open_circuit', reason: `fetch error: ${String(e).slice(0, 60)}` };
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
