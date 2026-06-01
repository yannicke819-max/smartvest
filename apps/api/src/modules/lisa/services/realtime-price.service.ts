import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import WebSocket from 'ws';
import { SupabaseService } from '../../supabase/supabase.service';

/** Rate limit EODHD documenté : 1000 requêtes / minute maximum.
 *  On se garde 10 % de marge → bloque à 900/min. */
const EODHD_RATE_LIMIT_PER_MINUTE = 1000;
const EODHD_RATE_LIMIT_SAFE_THRESHOLD = 900;
/** Fallback hard cap quotidien si /api/user n'est pas accessible.
 *  En temps normal on utilise le dailyRateLimit retourné par EODHD. */
const EODHD_DAILY_FALLBACK_CAP = 95_000;

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

  // PR #343 — observability WS Binance (Option C, snapshot 5 min).
  // Compteurs alimentés par le handler `message` ; reset après chaque snapshot.
  private msgCounter5min = 0;
  private lastMsgTs: number | null = null;

  /** Cache de prix : ticker uppercase → { price, source, asOf } */
  private cache = new Map<string, { price: string; source: 'binance_ws' | 'eodhd'; asOf: string }>();

  /** Historique des N dernières valeurs par ticker (pour détection figée).
   *  Si toutes les N entrées sont strictement égales, c'est presque toujours
   *  un cache fournisseur figé, un parser qui ré-injecte la même valeur, ou
   *  une source bloquée — donnée à ne PAS utiliser pour décision. */
  private priceHistory = new Map<string, Array<{ price: string; asOf: string }>>();
  private static readonly STALE_HISTORY_DEPTH = 5;

  /** Symbols d'intérêt (positions ouvertes crypto). Re-resolved périodiquement. */
  private activeCryptoSymbols = new Set<string>();

  /** Compteur journalier EODHD en cache. Source prioritaire : /api/user
   *  (valeur officielle EODHD). Fallback : count sur eodhd_request_log. */
  private eodhd24hCount = 0;
  private eodhd24hCountAsOf = 0;
  private eodhdDailyLimit = EODHD_DAILY_FALLBACK_CAP;
  private eodhdExtraLimit = 0;
  /**
   * P19s++ HOTFIX (30/04/2026) — Track if the last refresh succeeded via
   * EODHD /api/user (authoritative). When DB fallback is used, this is
   * `false` and we treat the count as APPROXIMATIVE (may overcount due
   * to retries/failures inflating eodhd_request_log).
   *
   * Bug observed prod 30/04 08:04 UTC : EODHD dashboard showed 13k actual
   * usage but local DB counter said 100k → blocked all calls. Caused by
   * eodhd_request_log inserting rows even on failed/retry calls, while
   * EODHD only counts billable calls.
   */
  private eodhd24hCountAuthoritative = false;

  /** Sliding window des timestamps des appels EODHD sortants dans les
   *  dernières 60 s — pour bloquer avant de hit le rate limit 1000/min. */
  private recentCallTimestamps: number[] = [];

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

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
    const key = symbol.toUpperCase();
    const ts = asOf ?? new Date().toISOString();
    this.cache.set(key, { price, source, asOf: ts });

    // Historique pour détection stale
    const hist = this.priceHistory.get(key) ?? [];
    hist.push({ price, asOf: ts });
    if (hist.length > RealtimePriceService.STALE_HISTORY_DEPTH) {
      hist.shift();
    }
    this.priceHistory.set(key, hist);
  }

  /** Détecte si les N dernières valeurs cachées sont strictement identiques.
   *  Retourne `false` si moins de N entrées (impossible de juger).
   *  Un consumer (ex. agent-lisa-sync) peut skipper une décision basée sur
   *  un prix figé pour éviter d'agir sur cache fournisseur bloqué. */
  isPriceStale(symbol: string): boolean {
    const key = symbol.toUpperCase();
    const hist = this.priceHistory.get(key);
    if (!hist || hist.length < RealtimePriceService.STALE_HISTORY_DEPTH) return false;
    const first = hist[0].price;
    return hist.every((h) => h.price === first);
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
      // Bug #G2 (13/05/2026) — MATIC → POL (Polygon rebrand sept 2024).
      // MATICUSDT figé sur Binance, redirection vers POLUSDT pour live price WS.
      // Mirror du fix dans binance-market.service.ts:toBinanceSymbol.
      'MATIC': 'POLUSDT', 'POL': 'POLUSDT',
      'LINK': 'LINKUSDT', 'LTC': 'LTCUSDT',
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
        // PR #343 — comptage messages pour snapshot santé (cron 5 min).
        // Tout message reçu compte, même un parse-error (preuve d activité réseau).
        this.msgCounter5min += 1;
        this.lastMsgTs = Date.now();
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

    // 1. Rate limit par minute (sliding window) — max 900 req/min
    //    pour garder 10% de marge sous le cap 1000/min d'EODHD.
    this.recentCallTimestamps = this.recentCallTimestamps.filter((t) => now - t < 60_000);
    if (this.recentCallTimestamps.length >= EODHD_RATE_LIMIT_SAFE_THRESHOLD) {
      this.logger.warn(`EODHD rate limit proche (${this.recentCallTimestamps.length}/min) — blocage momentané`);
      return 'blocked';
    }

    // 2. Quota journalier — REFRESH OBSERVABILITÉ UNIQUEMENT depuis /api/user
    //    (pas un blocage hard). Permet au /quota-status endpoint de logger
    //    l'usage main subscription avec exactitude.
    //
    // P19u (30/04/2026 08:30 UTC HOTFIX RATE-LIMIT) — Removed daily 100k
    // blocker entirely. User clarification : EODHD limite RÉELLEMENT au
    // RATE per-minute (1000 req/min), pas au daily count. HTTP 402
    // observé prod = burst > 1000 req/min, pas daily exhaustion.
    //
    // Le compteur daily reste en place pour observabilité (/lisa/eodhd-stats)
    // mais ne déclenche plus de blocage. Le rate-limiter sliding window
    // ci-dessus (étape 1) est la VRAIE protection contre les 402.
    if (now - this.eodhd24hCountAsOf > 60_000) {
      const refreshed = await this.refreshQuotaFromUserApi();
      if (refreshed) {
        this.eodhd24hCountAuthoritative = true;
      } else if (this.eodhd24hCountAsOf === 0) {
        // Boot path : pas encore de valeur connue. DB count comme proxy
        // OBSERVABILITÉ (over-counting accepté, jamais bloque).
        try {
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
          this.eodhd24hCountAuthoritative = false;
        } catch (e) {
          this.logger.debug(`Quota DB fallback failed: ${String(e).slice(0, 80)}`);
        }
      }
    }

    // P19v (30/04/2026 09:00 UTC) — RE-ENABLE 95% authoritative daily blocker.
    // User clarification finale : 100k DAILY est la vraie limite EODHD plan
    // ALL-IN-ONE. PR #143 fix authoritative était correct, PR #144 l'avait
    // retiré à tort. On le remet, MAIS gated sur authoritative source ONLY :
    //   - Si /api/user retourne apiRequests >= 95% (95k) → BLOCK
    //   - Si DB fallback (non-authoritative) → JAMAIS BLOCK (proxy faillible)
    const effectiveCap = this.eodhdDailyLimit + this.eodhdExtraLimit;
    const hardCapSafe = Math.floor(effectiveCap * 0.95);
    if (this.eodhd24hCountAuthoritative && this.eodhd24hCount >= hardCapSafe) {
      this.logger.warn(
        `EODHD daily quota >${Math.floor((this.eodhd24hCount/effectiveCap)*100)}% (${this.eodhd24hCount}/${effectiveCap}) — blocage authoritative`,
      );
      return 'blocked';
    }
    return 'ok';
  }

  /** Enregistre un appel sortant EODHD dans la sliding window.
   *  À appeler APRÈS que canCallEodhd() a retourné 'ok' ou 'warn'. */
  recordEodhdCall(): void {
    this.recentCallTimestamps.push(Date.now());
  }

  /** Fetch le compteur officiel EODHD via /api/user.
   *  Retourne true si succès, false si fallback nécessaire. */
  private async refreshQuotaFromUserApi(): Promise<boolean> {
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return false;

    try {
      const url = `https://eodhd.com/api/user?api_token=${apiKey}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const data = await res.json() as {
        apiRequests?: number;
        dailyRateLimit?: number;
        extraLimit?: number;
      };
      if (typeof data.apiRequests === 'number') this.eodhd24hCount = data.apiRequests;
      if (typeof data.dailyRateLimit === 'number' && data.dailyRateLimit > 0) {
        this.eodhdDailyLimit = data.dailyRateLimit;
      }
      if (typeof data.extraLimit === 'number') this.eodhdExtraLimit = data.extraLimit;
      this.eodhd24hCountAsOf = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /** Pour l'endpoint monitoring : expose le compteur et le cap courant. */
  getQuotaStatus(): {
    count24h: number;
    dailyLimit: number;
    extraLimit: number;
    effectiveCap: number;
    hardCap: number;
    warnThreshold: number;
    lastCheckAsOf: string | null;
    callsLastMinute: number;
    rateLimitPerMinute: number;
  } {
    const now = Date.now();
    const callsLastMinute = this.recentCallTimestamps.filter((t) => now - t < 60_000).length;
    const effectiveCap = this.eodhdDailyLimit + this.eodhdExtraLimit;
    return {
      count24h: this.eodhd24hCount,
      dailyLimit: this.eodhdDailyLimit,
      extraLimit: this.eodhdExtraLimit,
      effectiveCap,
      hardCap: Math.floor(effectiveCap * 0.95),
      warnThreshold: Math.floor(effectiveCap * 0.80),
      lastCheckAsOf: this.eodhd24hCountAsOf > 0 ? new Date(this.eodhd24hCountAsOf).toISOString() : null,
      callsLastMinute,
      rateLimitPerMinute: EODHD_RATE_LIMIT_PER_MINUTE,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PR #343 — Observability snapshot Binance WS (Option C, sans changer le
  // comportement runtime). Logue toutes les 5 min un JSON structuré pour
  // permettre grep VictoriaLogs + alerting silent-failure futur.
  // ─────────────────────────────────────────────────────────────────────────

  /** Map WebSocket readyState → label lisible. Visible pour tests. */
  mapWsState(readyState: number | undefined | null): string {
    if (readyState === undefined || readyState === null) return 'NOT_INITIALIZED';
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return states[readyState] ?? 'UNKNOWN';
  }

  /**
   * Détecte une "silent failure" : WS rapporte OPEN mais aucun message
   * reçu sur les 5 dernières minutes alors que des symboles sont abonnés.
   * Visible pour tests unitaires.
   */
  static computeSilentFailureSuspected(
    wsState: string,
    symbolsSubscribedCount: number,
    msgCount5min: number,
  ): boolean {
    return wsState === 'OPEN' && symbolsSubscribedCount > 0 && msgCount5min === 0;
  }

  /**
   * Compte les positions crypto ouvertes du portfolio principal.
   * Lecture-seule Supabase. Fail-open : retourne null si erreur (pas de crash cron).
   */
  async getOpenCryptoPositionsCount(): Promise<number | null> {
    if (!this.supabase.isReady()) return null;
    const portfolioId =
      this.config.get<string>('PORTFOLIO_ID') ?? 'b0000001-0000-0000-0000-000000000001'; // ex-MAIN 58439d86 migré 30/05/2026
    try {
      const { count, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id', { count: 'exact', head: true })
        .eq('portfolio_id', portfolioId)
        .in('asset_class', ['crypto_major', 'crypto_alt'])
        .eq('status', 'open');
      if (error) {
        this.logger.warn(`[binance-ws-health] crypto positions query failed: ${error.message}`);
        return null;
      }
      return count ?? 0;
    } catch (err) {
      this.logger.warn(`[binance-ws-health] crypto positions exception: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Cron 5 min : snapshot santé Binance WS en JSON structuré.
   * Désactivable via `BINANCE_WS_HEALTH_LOG_ENABLED=false` (default true).
   */
  @Cron('*/5 * * * *', { name: 'binance-ws-health-snapshot' })
  async logBinanceWsHealthSnapshot(): Promise<void> {
    const flag = this.config.get<string>('BINANCE_WS_HEALTH_LOG_ENABLED') ?? 'true';
    if (flag !== 'true') return;

    const now = Date.now();
    const wsState = this.mapWsState(this.ws?.readyState);
    const symbolsSubscribed = Array.from(this.subscribedStreams);
    const lastMsgAgeSeconds = this.lastMsgTs ? (now - this.lastMsgTs) / 1000 : null;
    const openCryptoPositions = await this.getOpenCryptoPositionsCount();
    const silentFailureSuspected = RealtimePriceService.computeSilentFailureSuspected(
      wsState,
      symbolsSubscribed.length,
      this.msgCounter5min,
    );

    const snapshot = {
      event: 'binance_ws_health',
      ts_utc: new Date(now).toISOString(),
      ws_state: wsState,
      symbols_subscribed_count: symbolsSubscribed.length,
      symbols_subscribed: symbolsSubscribed,
      msg_count_last_5min: this.msgCounter5min,
      last_msg_age_seconds: lastMsgAgeSeconds,
      open_crypto_positions: openCryptoPositions,
      silent_failure_suspected: silentFailureSuspected,
    };

    this.logger.log(`[binance-ws-health] ${JSON.stringify(snapshot)}`);
    if (silentFailureSuspected) {
      this.logger.warn(
        `[binance-ws-health] SILENT FAILURE SUSPECTED: ws=OPEN, ${symbolsSubscribed.length} symbols, 0 msg in 5min`,
      );
    }

    // Reset compteur fenêtre 5 min.
    this.msgCounter5min = 0;
  }
}
