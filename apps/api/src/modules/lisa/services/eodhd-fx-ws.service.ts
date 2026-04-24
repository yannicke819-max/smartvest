import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import WebSocket from 'ws';

/**
 * EodhdFxWsService — connexion WebSocket persistante à wss://ws.eodhistoricaldata.com/ws/forex
 * pour recevoir les ticks FX en streaming (EUR/USD, USD/JPY, GBP/USD).
 *
 * Remplace le polling 30s → latence < 500ms sur les cotations FX.
 *
 * Architecture :
 *  - Une seule connexion WS par process (singleton NestJS)
 *  - Reconnect exponentiel : 2s, 4s, 8s, 16s, 30s cap
 *  - Fail-safe : si la clé EODHD manque ou si la connexion échoue, le
 *    service reste silencieux (no throw). Le polling existant continue
 *    de fournir des prix fallback.
 *  - Cache in-memory { symbol → { bid, ask, mid, asOf } }, TTL lu à la
 *    demande par le consommateur.
 *
 * Protocole EODHD FX :
 *   connect wss://ws.eodhistoricaldata.com/ws/forex?api_token=X
 *   send    {"action":"subscribe","symbols":"EURUSD,USDJPY,GBPUSD"}
 *   recv    {"s":"EURUSD","a":1.0843,"b":1.0842,"t":1704721200}
 *             s=symbol, a=ask, b=bid, t=timestamp ms
 */

export interface FxTick {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  asOf: number;
}

const DEFAULT_SYMBOLS = ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCHF'];
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

@Injectable()
export class EodhdFxWsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EodhdFxWsService.name);
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private ticks = new Map<string, FxTick>();

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Démarrage non-bloquant — aucune exception ne doit remonter au boot.
    setImmediate(() => this.connect().catch((e) => {
      this.logger.warn(`FX WS initial connect failed: ${String(e).slice(0, 80)}`);
      this.scheduleReconnect();
    }));
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /** Récupère le dernier tick d'une paire. null si inconnu ou > 30s stale. */
  getTick(symbol: string, maxAgeMs = 30_000): FxTick | null {
    const key = this.normalizeSymbol(symbol);
    const t = this.ticks.get(key);
    if (!t) return null;
    if (Date.now() - t.asOf > maxAgeMs) return null;
    return t;
  }

  /** Résumé compact pour le briefing Lisa (EURUSD/USDJPY/GBPUSD + asOf). */
  summarize(): string {
    const items: string[] = [];
    for (const sym of ['EURUSD', 'USDJPY', 'GBPUSD']) {
      const t = this.getTick(sym, 60_000);
      if (t) {
        items.push(`${sym}=${t.mid.toFixed(4)}`);
      }
    }
    if (items.length === 0) return '';
    return `FX stream: ${items.join(' · ')}`;
  }

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  private normalizeSymbol(s: string): string {
    return s.toUpperCase().replace(/[\s-_/]/g, '');
  }

  private async connect(): Promise<void> {
    const key = this.apiKey();
    if (!key) {
      // Pas de clé : on ne tente jamais et on ne programme pas de reconnect
      return;
    }
    if (this.shuttingDown) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const url = `wss://ws.eodhistoricaldata.com/ws/forex?api_token=${key}`;
    this.logger.log(`FX WS connecting (attempt ${this.reconnectAttempts + 1})…`);

    const ws = new WebSocket(url, {
      handshakeTimeout: 10_000,
      perMessageDeflate: false,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.logger.log('FX WS open, subscribing…');
      this.reconnectAttempts = 0;
      try {
        ws.send(JSON.stringify({ action: 'subscribe', symbols: DEFAULT_SYMBOLS.join(',') }));
      } catch (e) {
        this.logger.warn(`FX WS subscribe send failed: ${String(e).slice(0, 80)}`);
      }
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const sym = typeof msg.s === 'string' ? msg.s.toUpperCase() : null;
        const bid = Number(msg.b ?? 0);
        const ask = Number(msg.a ?? 0);
        if (!sym || !isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) return;
        const mid = (bid + ask) / 2;
        this.ticks.set(sym, { symbol: sym, bid, ask, mid, asOf: Date.now() });
      } catch {
        // Message status d'EODHD (ex: {"status_code":200,"message":"Authorized"}) → ignore
      }
    });

    ws.on('error', (err) => {
      this.logger.warn(`FX WS error: ${String(err).slice(0, 120)}`);
      // 'close' sera émis juste après, on y gère le reconnect
    });

    ws.on('close', (code) => {
      this.logger.warn(`FX WS closed (code=${code})`);
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx];
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) => {
        this.logger.warn(`FX WS reconnect failed: ${String(e).slice(0, 80)}`);
        this.scheduleReconnect();
      });
    }, delay);
  }
}
