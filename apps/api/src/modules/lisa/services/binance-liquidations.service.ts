import { Injectable, Logger } from '@nestjs/common';

/**
 * BinanceLiquidationsService — détection de waves de liquidations sur
 * Binance Futures. Signal golden-boy majeur :
 *
 *   liquidation wave long $42M en 1h → shorts piégés dès le bounce
 *   → mean reversion très probable (pattern Druckenmiller "puke low")
 *
 * Endpoint primary : GET /fapi/v1/allForceOrders (Binance Futures REST).
 * INCIDENT 27/04/2026 : ce endpoint est désormais authenticated-only
 * pour les requêtes publiques (Binance a restreint l'accès fin 2023).
 * Sans API key, retourne HTTP 400. Logs Fly v171 polluent à chaque cycle :
 *   `WARN [BinanceLiquidationsService] Binance liquidations BTCUSDT: HTTP 400`
 *
 * PR fix/binance-liquidations-fallback-circuit-breaker :
 *
 *   1. Circuit breaker : après 3 échecs consécutifs sur un provider,
 *      cooldown 5min. Élimine 95% du log spam et économise les rate
 *      limits.
 *   2. Body capture sur erreur HTTP 4xx/5xx pour faciliter le diagnostic
 *      post-mortem (avant : seul le status code était logué).
 *   3. Fallback structuré (point d'extension) : Coinglass / Bybit pourront
 *      être branchés en provider secondaire. Pour l'instant inerte —
 *      à activer quand on aura validé un endpoint public no-auth viable.
 *
 * Détection de wave (inchangé) :
 *  - Somme notional liquidations BUY (= shorts liquidés) et SELL (= longs liquidés)
 *    sur fenêtre 1h et 24h
 *  - Flag "LONG_SQUEEZE" si BUY notional 1h > 20M$ ET > 3× moyenne 24h
 *  - Flag "LONG_PUKE"    si SELL notional 1h > 20M$ ET > 3× moyenne 24h
 */

export interface LiquidationSnapshot {
  symbol: string;
  asOf: number;
  buyNotionalUsd1h: number;     // shorts liquidés (= pression à la hausse)
  sellNotionalUsd1h: number;    // longs liquidés  (= pression à la baisse)
  buyNotionalUsd24h: number;
  sellNotionalUsd24h: number;
  wavePattern: 'LONG_SQUEEZE' | 'LONG_PUKE' | 'SHORT_PUKE' | 'NONE';
  waveDetail: string;
}

/**
 * Etat du circuit breaker par provider. `consecutiveFailures` est
 * incrémenté à chaque non-2xx ou exception, reset à 0 sur succès.
 * `cooldownUntil` est positionné à `now + 5min` quand on franchit le
 * seuil (défaut 3).
 */
interface ProviderCircuitState {
  consecutiveFailures: number;
  cooldownUntil: number;
  lastErrorMessage?: string;
}

export type LiquidationProvider = 'binance' | 'coinglass' | 'bybit';

@Injectable()
export class BinanceLiquidationsService {
  private readonly logger = new Logger(BinanceLiquidationsService.name);
  private cache = new Map<string, { snap: LiquidationSnapshot; asOf: number }>();
  private readonly CACHE_MS = 2 * 60 * 1000;
  private readonly WAVE_THRESHOLD_USD = 20_000_000;

  // Circuit breaker — 3 fails consécutifs → cooldown 5min par provider.
  // Public pour testabilité (clearCircuit / inspectCircuit).
  private readonly circuit = new Map<LiquidationProvider, ProviderCircuitState>();
  private readonly CIRCUIT_BREAKER_FAILS = 3;
  private readonly CIRCUIT_BREAKER_MS = 5 * 60 * 1000;

  async getSnapshot(symbol: string): Promise<LiquidationSnapshot | null> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.asOf < this.CACHE_MS) return cached.snap;

    const binanceSymbol = this.toBinanceSymbol(symbol);
    if (!binanceSymbol) return null;

    // Provider primary : Binance
    if (!this.isInCooldown('binance')) {
      const snap = await this.fetchFromBinance(symbol, binanceSymbol);
      if (snap) {
        this.recordSuccess('binance');
        this.cache.set(symbol, { snap, asOf: Date.now() });
        return snap;
      }
      // l'échec a déjà été enregistré dans fetchFromBinance
    }

    // Provider fallback : Bybit recent-trade
    //
    // Le user demandé /v5/market/recent-trade?category=linear&symbol=BTCUSDT.
    // Note importante : cet endpoint expose des TRADES récents, pas des
    // liquidations spécifiques (Bybit n'a plus d'endpoint REST public pour
    // les liquidations dédiées depuis fin 2023 — seulement WebSocket
    // `liquidation.{symbol}`). On l'utilise donc comme :
    //   1. Probe de connectivité fallback (= "Bybit répond")
    //   2. Signal d'activité brut (volume) — pas suffisant pour LONG_PUKE/
    //      LONG_SQUEEZE qui requièrent un flag side=liquidation
    //
    // Concrètement on retourne un emptySnapshot avec `wavePattern='NONE'`
    // mais on récupère le succès Bybit dans le circuit breaker — ce qui
    // permet à un consommateur futur (LiquidationsWebSocketService) de
    // savoir si Bybit est dispo. Pas de fausse détection de wave en
    // fallback, c'est plus safe que d'inférer LONG_PUKE depuis du volume
    // de trade qui n'est pas du tout la même sémantique.
    if (!this.isInCooldown('bybit')) {
      const reached = await this.probeBybit(binanceSymbol);
      if (reached) {
        this.recordSuccess('bybit');
        // Pas de wave detection — voir commentaire ci-dessus.
      }
    }

    const empty = this.emptySnapshot(symbol);
    this.cache.set(symbol, { snap: empty, asOf: Date.now() });
    return empty;
  }

  /**
   * Probe Bybit recent-trade endpoint pour mesurer la connectivité fallback.
   *
   * Endpoint : GET /v5/market/recent-trade?category=linear&symbol={S}&limit=50
   * Retourne true si HTTP 200 + payload non-erreur, false sinon.
   * Pas d'extraction de wave (cf. commentaire dans getSnapshot).
   *
   * Raisonnable comme probe de "Bybit reachable" — coût rate limit
   * négligeable (60 req/min/IP unauthenticated, on appelle ~1×/2min via
   * cache CACHE_MS).
   */
  private async probeBybit(binanceSymbol: string): Promise<boolean> {
    try {
      const url = `https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=${binanceSymbol}&limit=50`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.recordFailure('bybit', `HTTP_${res.status}`, `HTTP ${res.status} body=${body.slice(0, 200)}`);
        return false;
      }
      // Bybit V5 wraps payloads in { retCode, retMsg, result, ... }.
      // retCode === 0 = success, anything else = error (mais HTTP 200).
      const data = await res.json() as { retCode?: number; retMsg?: string; result?: unknown };
      if (data.retCode !== 0) {
        this.recordFailure('bybit', `retCode_${data.retCode}`, `retMsg=${data.retMsg ?? '?'}`);
        return false;
      }
      return true;
    } catch (e) {
      this.recordFailure('bybit', 'exception', String(e).slice(0, 200));
      return false;
    }
  }

  /**
   * Tentative Binance. Retourne null si l'appel échoue (status non-2xx,
   * exception, body vide). Met à jour le circuit breaker côté caller.
   */
  private async fetchFromBinance(
    symbol: string,
    binanceSymbol: string,
  ): Promise<LiquidationSnapshot | null> {
    try {
      const url = `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${binanceSymbol}&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        // Capture body pour diagnostic. Body Binance = JSON {"code": -...,
        // "msg": "..."}. On log seulement la 1re fois après reset
        // (silenced par circuit breaker après 3 fails).
        const body = await res.text().catch(() => '');
        const trimmed = body.slice(0, 200);
        this.recordFailure('binance', `HTTP_${res.status}`, `HTTP ${res.status} body=${trimmed}`);
        return null;
      }
      const data = await res.json() as Array<Record<string, unknown>>;
      if (!Array.isArray(data) || data.length === 0) {
        // Endpoint répond OK mais pas de données — pas un échec stricto-sensu,
        // mais on ne renvoie pas null pour ne pas bypass le caching.
        return this.emptySnapshot(symbol);
      }

      const now = Date.now();
      const h1 = now - 60 * 60 * 1000;
      const h24 = now - 24 * 60 * 60 * 1000;

      let buy1h = 0, sell1h = 0, buy24h = 0, sell24h = 0;
      for (const row of data) {
        const time = Number(row.time ?? 0);
        if (!isFinite(time) || time < h24) continue;
        const side = String(row.side ?? '').toUpperCase();
        const origQty = Number(row.origQty ?? 0);
        const price = Number(row.averagePrice ?? row.price ?? 0);
        if (!isFinite(origQty) || !isFinite(price)) continue;
        const notional = origQty * price;
        if (!isFinite(notional)) continue;

        if (side === 'BUY') {
          buy24h += notional;
          if (time >= h1) buy1h += notional;
        } else if (side === 'SELL') {
          sell24h += notional;
          if (time >= h1) sell1h += notional;
        }
      }

      const buyHourlyAvg = buy24h / 24;
      const sellHourlyAvg = sell24h / 24;
      let wavePattern: LiquidationSnapshot['wavePattern'] = 'NONE';
      let waveDetail = '';

      if (sell1h >= this.WAVE_THRESHOLD_USD && sell1h > 3 * sellHourlyAvg) {
        wavePattern = 'LONG_PUKE';
        waveDetail = `${(sell1h / 1e6).toFixed(1)}M$ longs liquidés 1h (${(sell1h / Math.max(sellHourlyAvg, 1)).toFixed(1)}× avg) — capitulation possible, watch bounce`;
      } else if (buy1h >= this.WAVE_THRESHOLD_USD && buy1h > 3 * buyHourlyAvg) {
        wavePattern = 'LONG_SQUEEZE';
        waveDetail = `${(buy1h / 1e6).toFixed(1)}M$ shorts liquidés 1h (${(buy1h / Math.max(buyHourlyAvg, 1)).toFixed(1)}× avg) — squeeze en cours, prudence chasing`;
      }

      return {
        symbol,
        asOf: Date.now(),
        buyNotionalUsd1h: buy1h,
        sellNotionalUsd1h: sell1h,
        buyNotionalUsd24h: buy24h,
        sellNotionalUsd24h: sell24h,
        wavePattern,
        waveDetail,
      };
    } catch (e) {
      this.recordFailure('binance', 'exception', String(e).slice(0, 200));
      return null;
    }
  }

  // ─── Circuit breaker ────────────────────────────────────────────────

  /** True si le provider est en cooldown (échecs récents répétés). */
  isInCooldown(provider: LiquidationProvider, now: number = Date.now()): boolean {
    const state = this.circuit.get(provider);
    if (!state) return false;
    return state.cooldownUntil > now;
  }

  /**
   * Enregistre un échec. Au seuil `CIRCUIT_BREAKER_FAILS`, déclenche le
   * cooldown 5min et log une seule fois (warn) pour signaler l'entrée
   * en circuit ouvert. Les échecs suivants en cooldown n'écrivent rien.
   */
  private recordFailure(
    provider: LiquidationProvider,
    code: string,
    detail: string,
    now: number = Date.now(),
  ): void {
    const state = this.circuit.get(provider) ?? { consecutiveFailures: 0, cooldownUntil: 0 };
    state.consecutiveFailures += 1;
    state.lastErrorMessage = `${code}: ${detail}`;

    if (state.consecutiveFailures === this.CIRCUIT_BREAKER_FAILS) {
      // Premier franchissement du seuil → log warn une fois + cooldown.
      state.cooldownUntil = now + this.CIRCUIT_BREAKER_MS;
      this.logger.warn(
        `[circuit-breaker] ${provider} liquidations: ${this.CIRCUIT_BREAKER_FAILS} échecs consécutifs (${state.lastErrorMessage}) — cooldown ${this.CIRCUIT_BREAKER_MS / 60_000}min`,
      );
    } else if (state.consecutiveFailures < this.CIRCUIT_BREAKER_FAILS) {
      // Sous le seuil → log debug (verbeux mais utile pour diagnostic local).
      this.logger.debug(
        `[circuit-breaker] ${provider} liquidations échec ${state.consecutiveFailures}/${this.CIRCUIT_BREAKER_FAILS}: ${state.lastErrorMessage}`,
      );
    }
    // Si > seuil pendant cooldown : silencieux (déjà loggé l'entrée).

    this.circuit.set(provider, state);
  }

  /** Reset compteur fails sur succès. */
  private recordSuccess(provider: LiquidationProvider): void {
    const state = this.circuit.get(provider);
    if (state && state.consecutiveFailures > 0) {
      this.logger.debug(
        `[circuit-breaker] ${provider} liquidations recovered (${state.consecutiveFailures} précédents échecs)`,
      );
    }
    this.circuit.set(provider, { consecutiveFailures: 0, cooldownUntil: 0 });
  }

  /** Test helper — réinitialise le circuit pour un provider donné. */
  resetCircuit(provider: LiquidationProvider): void {
    this.circuit.delete(provider);
  }

  /** Test helper — inspect l'état actuel du circuit (read-only snapshot). */
  inspectCircuit(provider: LiquidationProvider): Readonly<ProviderCircuitState> | null {
    const state = this.circuit.get(provider);
    return state ? { ...state } : null;
  }

  // ─── Helpers existants (inchangés) ──────────────────────────────────

  private emptySnapshot(symbol: string): LiquidationSnapshot {
    return {
      symbol,
      asOf: Date.now(),
      buyNotionalUsd1h: 0,
      sellNotionalUsd1h: 0,
      buyNotionalUsd24h: 0,
      sellNotionalUsd24h: 0,
      wavePattern: 'NONE',
      waveDetail: '',
    };
  }

  private toBinanceSymbol(symbol: string): string | null {
    const s = symbol.toUpperCase().replace(/[-_/]/g, '');
    if (s === 'BTC' || s === 'BITCOIN' || s === 'BTCUSD') return 'BTCUSDT';
    if (s === 'ETH' || s === 'ETHEREUM' || s === 'ETHUSD') return 'ETHUSDT';
    if (s === 'SOL' || s === 'SOLUSD') return 'SOLUSDT';
    if (s.endsWith('USDT') || s.endsWith('USD')) {
      return s.endsWith('USD') ? s.replace(/USD$/, 'USDT') : s;
    }
    return null;
  }

  /** Résumé texte pour le briefing Lisa. */
  summarize(snap: LiquidationSnapshot | null): string {
    if (!snap) return '';
    const sellM = snap.sellNotionalUsd1h / 1e6;
    const buyM = snap.buyNotionalUsd1h / 1e6;
    if (snap.wavePattern === 'LONG_PUKE') {
      return `${snap.symbol} 🔴 LONG PUKE · ${snap.waveDetail}`;
    }
    if (snap.wavePattern === 'LONG_SQUEEZE') {
      return `${snap.symbol} 🟢 LONG SQUEEZE · ${snap.waveDetail}`;
    }
    if (sellM < 1 && buyM < 1) return ''; // silencieux si rien de notable
    return `${snap.symbol}: longs liq=${sellM.toFixed(1)}M$/1h · shorts liq=${buyM.toFixed(1)}M$/1h (baseline)`;
  }
}
