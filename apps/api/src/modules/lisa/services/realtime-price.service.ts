import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import WebSocket from 'ws';
import { SupabaseService } from '../../supabase/supabase.service';

/** Hard cap à 95k/j (100k quota EODHD moins 5k de marge de sécurité). */
const EODHD_DAILY_HARD_CAP = 95_000;
/** Seuil à partir duquel on ralentit préventivement (80% du cap). */
const EODHD_DAILY_WARN_THRESHOLD = 80_000;

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
 *
 * Utilise le package `ws` (Node.js) car le WebSocket global natif n'est
 * disponible qu'à partir de Node 22 — le runtime prod tourne sur Node 20.
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

  /** Compteur 24h EODHD en cache, rafraîchi depuis eodhd_request_log. */
  private eodhd24hCount = 0;
  private eodhd24hCountAsOf = 0;

  constructor(private readonly supabase: SupabaseService) {}

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

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.logger.log('Binance WS connected');
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const raw = data.toString('utf8');
          const msg = JSON.parse(raw);
          const payload = msg.data ?? msg;
          if (payload && typeof payload.s === 'string' && typeof payload.c === 'string') {
            this.setCached(payload.s, payload.c, 'binance_ws');
          }
        } catch (e) {
          this.logger.debug(`WS parse error: ${String(e).slice(0, 80)}`);
        }
      });

      this.ws.on('error', (e: Error) => {
        this.logger.warn(`Binance WS error: ${e.message.slice(0, 100)}`);
      });

      this.ws.on('close', () => {
        this.logger.warn('Binance WS closed — retry soon');
        this.scheduleReconnect();
      });
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

  /** État connecté ? (WebSocket.OPEN === 1) */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Vérifie si on peut encore appeler EODHD aujourd'hui sans dépasser le cap.
   * Le compteur est rafraîchi toutes les 60 s depuis eodhd_request_log.
   * Si l'usage dépasse le hard cap → refuse ; si > warn threshold → log warn
   * mais laisse passer.
   *
   * Retourne :
   *   - 'ok' : call autorisé
   *   - 'warn' : call autorisé mais proche du cap (logger avertit)
   *   - 'blocked' : call refusé, utiliser le cache même périmé
   */
  async canCallEodhd(): Promise<'ok' | 'warn' | 'blocked'> {
    const now = Date.now();
    // Rafraîchit le compteur si cache > 60s
    if (now - this.eodhd24hCountAsOf > 60_000) {
      try {
        // Reset CALENDAIRE à 00:00 UTC — aligne avec le reset quota EODHD réel
        const nowDate = new Date(now);
        const startOfTodayUtc = new Date(Date.UTC(
          nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(),
          0, 0, 0, 0,
        )).toISOString();
        const { count } = await this.supabase.getClient()
          .from('eodhd_request_log')
          .select('*', { count: 'exact', head: true })
          .eq('source', 'eodhd')
          .gte('timestamp', startOfTodayUtc);
        this.eodhd24hCount = count ?? 0;
        this.eodhd24hCountAsOf = now;
      } catch (e) {
        this.logger.warn(`Quota check failed: ${String(e).slice(0, 80)}. Letting call through.`);
        return 'ok';
      }
    }

    if (this.eodhd24hCount >= EODHD_DAILY_HARD_CAP) {
      this.logger.warn(`EODHD quota cap hit (${this.eodhd24hCount}/${EODHD_DAILY_HARD_CAP}) — blocking new calls, serving cache`);
      return 'blocked';
    }
    if (this.eodhd24hCount >= EODHD_DAILY_WARN_THRESHOLD) {
      return 'warn';
    }
    return 'ok';
  }

  /** Pour l'endpoint monitoring : expose le compteur et le cap courant. */
  getQuotaStatus(): { count24h: number; hardCap: number; warnThreshold: number; lastCheckAsOf: string | null } {
    return {
      count24h: this.eodhd24hCount,
      hardCap: EODHD_DAILY_HARD_CAP,
      warnThreshold: EODHD_DAILY_WARN_THRESHOLD,
      lastCheckAsOf: this.eodhd24hCountAsOf > 0 ? new Date(this.eodhd24hCountAsOf).toISOString() : null,
    };
  }
}
