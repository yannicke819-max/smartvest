import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * RealtimePriceService — cache unifié de prix en mémoire.
 *
 *  - Crypto : abonné au WebSocket public Binance (wss://stream.binance.com:9443)
 *    pour recevoir les tickers en continu (~1 update/sec par symbole). Gratuit,
 *    pas de limite de quota, latence ~200ms.
 *  - Autres (actions, FX, ETF) : mis à jour via EODHD en pull régulier par le
 *    RealtimePriceRefreshService (cron indépendant).
 *
 * Le cache sert à deux choses :
 *   1. Éviter les appels EODHD à chaque fetchLivePrice (économie quota).
 *   2. Fournir des prix "quasi temps réel" au fast risk monitor pour
 *      déclencher stop/target avec un délai < 1 seconde côté crypto.
 */
@Injectable()
export class RealtimePriceService implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePriceService.name);
  private ws: WebSocket | null = null;
  private subscribedStreams = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cache de prix : ticker uppercase → { price, source, asOf } */
  private cache = new Map<string, { price: string; source: 'binance_ws' | 'eodhd'; asOf: string }>();

  /** Symbols d'intérêt (positions ouvertes crypto). Re-resolved périodiquement. */
  private activeCryptoSymbols = new Set<string>();

  onModuleDestroy(): void {
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  /** Retourne un prix du cache si récent (<60s), sinon null. */
  getCached(symbol: string): { price: string; source: string; asOf: string } | null {
    const s = symbol.toUpperCase();
    // Try direct match
    let hit = this.cache.get(s);
    // Try crypto variants (BTC → BTCUSDT) si pas trouvé
    if (!hit && !s.endsWith('USDT') && !s.endsWith('USD') && !s.includes('-')) {
      hit = this.cache.get(`${s}USDT`);
    }
    if (!hit && s.endsWith('-USD')) {
      hit = this.cache.get(s.replace('-USD', 'USDT'));
    }
    if (!hit) return null;
    const ageMs = Date.now() - new Date(hit.asOf).getTime();
    if (ageMs > 60_000) return null;
    return hit;
  }

  /** Met à jour le cache (utilisé par le refresh EODHD). */
  setCached(symbol: string, price: string, source: 'binance_ws' | 'eodhd', asOf?: string): void {
    this.cache.set(symbol.toUpperCase(), {
      price,
      source,
      asOf: asOf ?? new Date().toISOString(),
    });
  }

  /** Dit au service quels symbols crypto surveiller (re-appelé après chaque cycle). */
  updateActiveCryptoSymbols(symbols: string[]): void {
    const next = new Set<string>();
    for (const s of symbols) {
      const binanceSymbol = this.toBinanceSymbol(s);
      if (binanceSymbol) next.add(binanceSymbol);
    }
    // Pas de changement → rien à faire
    if (this.setsEqual(next, this.activeCryptoSymbols)) return;
    this.activeCryptoSymbols = next;
    this.reconnectIfNeeded();
  }

  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  /** Converte un symbole SmartVest en symbole Binance (BTCUSDT). */
  private toBinanceSymbol(symbol: string): string | null {
    const s = symbol.toUpperCase().replace(/[-\s]/g, '');
    // Déjà un pair Binance
    if (s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('BUSD')) return s;
    // Crypto courante avec suffixe EUR/USD → on convertit en USDT (liquidité)
    const map: Record<string, string> = {
      'BTCUSD': 'BTCUSDT', 'BTCEUR': 'BTCUSDT', 'BTCSPOT': 'BTCUSDT', 'BTC': 'BTCUSDT',
      'ETHUSD': 'ETHUSDT', 'ETHEUR': 'ETHUSDT', 'ETHSPOT': 'ETHUSDT', 'ETH': 'ETHUSDT',
      'SOL': 'SOLUSDT', 'BNB': 'BNBUSDT', 'XRP': 'XRPUSDT', 'ADA': 'ADAUSDT',
      'DOGE': 'DOGEUSDT', 'DOT': 'DOTUSDT', 'AVAX': 'AVAXUSDT',
      'MATIC': 'MATICUSDT', 'LINK': 'LINKUSDT', 'LTC': 'LTCUSDT',
      'ATOM': 'ATOMUSDT', 'UNI': 'UNIUSDT',
    };
    return map[s] ?? null;
  }

  /** (Re)connecte le WebSocket avec les streams courants. */
  private reconnectIfNeeded(): void {
    // Close existing
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.activeCryptoSymbols.size === 0) {
      this.logger.log('RealtimePriceService : aucun symbole crypto actif — WS fermé');
      return;
    }

    // Combined stream — multi-ticker en une seule connexion
    const streams = Array.from(this.activeCryptoSymbols)
      .map((s) => `${s.toLowerCase()}@ticker`)
      .join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    try {
      this.ws = new WebSocket(url);
      this.subscribedStreams = new Set(this.activeCryptoSymbols);
      this.logger.log(`Binance WS connecting : ${this.activeCryptoSymbols.size} symbol(s) [${Array.from(this.activeCryptoSymbols).join(', ')}]`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.logger.log('Binance WS connected');
      };

      this.ws.onmessage = (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
          const msg = JSON.parse(raw);
          // Combined stream format: { stream: 'btcusdt@ticker', data: { s: 'BTCUSDT', c: '79123.45', ... } }
          const data = msg.data ?? msg;
          if (data && typeof data.s === 'string' && typeof data.c === 'string') {
            this.setCached(data.s, data.c, 'binance_ws');
          }
        } catch (e) {
          this.logger.debug(`WS parse error: ${String(e).slice(0, 80)}`);
        }
      };

      this.ws.onerror = (e) => {
        this.logger.warn(`Binance WS error: ${String(e).slice(0, 100)}`);
      };

      this.ws.onclose = () => {
        this.logger.warn('Binance WS closed — retry soon');
        this.scheduleReconnect();
      };
    } catch (e) {
      this.logger.error(`Binance WS init failed: ${String(e)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.activeCryptoSymbols.size > 0) this.reconnectIfNeeded();
    }, delay);
  }

  /** Snapshot du cache pour debug / monitoring. */
  snapshot(): Array<{ symbol: string; price: string; source: string; ageMs: number }> {
    const now = Date.now();
    return Array.from(this.cache.entries()).map(([symbol, entry]) => ({
      symbol,
      price: entry.price,
      source: entry.source,
      ageMs: now - new Date(entry.asOf).getTime(),
    }));
  }

  /** Nombre de symboles crypto actuellement abonnés. */
  getActiveCryptoCount(): number {
    return this.activeCryptoSymbols.size;
  }

  /** État connecté ? */
  isConnected(): boolean {
    return this.ws?.readyState === 1;
  }
}
