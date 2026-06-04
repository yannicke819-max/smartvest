import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DEAD_NSE_TICKERS } from '@smartvest/ai-analyst';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * Bug #R10 + PR #337 — Blacklist tickers EODHD confirmés inutiles.
 *
 * Deux niveaux :
 *   1. Statique : 23 tickers (.NSE morts 404 + .KO/.KQ empty-response + saigneur).
 *      Liste exportée par `@smartvest/ai-analyst` (DEAD_TICKERS_STATIC, alias
 *      DEAD_NSE_TICKERS conservé pour backward-compat).
 *      Mesure 17/05/2026 : ~143k calls EODHD gaspillés sur 7j + hémorragie -$119/j.
 *   2. Dynamique : compteur de strikes 404 par ticker sur fenêtre glissante 24h.
 *      Au-delà du seuil (`GAINERS_AUTO_BLACKLIST_404_STRIKES`, default 3) → ban
 *      pour `GAINERS_AUTO_BLACKLIST_TTL_HOURS` heures (default 24).
 *
 * Stockage MVP : in-memory Map pour la partie dynamique. Pas d'ALTER TABLE
 * Supabase à ce sprint. La perte de l'état au restart Fly est tolérable :
 * la liste statique couvre les leaks majeurs, et un strike-counter en mémoire
 * reconverge en quelques cycles.
 *
 * Env vars :
 *   - GAINERS_NSE_BLACKLIST_ENABLED       (default true) — couvre TOUT le static
 *   - GAINERS_AUTO_BLACKLIST_404_STRIKES  (default 3)
 *   - GAINERS_AUTO_BLACKLIST_TTL_HOURS    (default 24)
 *
 * Note : `GAINERS_NSE_BLACKLIST_ENABLED=false` désactive AUSSI la blacklist asia
 * (même flag par simplicité — flag par catégorie n'apporte rien tant qu'on ne
 * fait pas de rollback partiel). Si rollback urgent sur asia uniquement, retirer
 * les lignes asia du Set DEAD_TICKERS_STATIC et redeploy.
 *
 * Pour les tests : injection ConfigService partiel suffit, pas de DB.
 */

const DEFAULT_STRIKES = 3;
const DEFAULT_TTL_HOURS = 24;
const STRIKE_WINDOW_HOURS = 24;

interface StrikeRecord {
  /** Timestamps unix (ms) des erreurs 404 récentes, triées asc, max 10. */
  strikes: number[];
  /** Si défini : ticker blacklisté jusqu'à ce timestamp. */
  blacklistedUntilMs?: number;
  /** Pour log / debug. */
  lastReason?: string;
}

export interface BlacklistStats {
  staticEnabled: boolean;
  staticSize: number;
  dynamicCount: number;
  strikesThreshold: number;
  ttlHours: number;
}

@Injectable()
export class TickerBlacklistService {
  private readonly logger = new Logger(TickerBlacklistService.name);
  private readonly records = new Map<string, StrikeRecord>();
  /**
   * Whitelist des symbols actuellement en position ouverte — exempts de
   * l'auto-blacklist 24h. Sinon on perdrait l'accès live price EODHD pour
   * nos holdings, plus aucun fallback possible quand TwelveData renvoie
   * un quote stale (bug LSE/Euronext 25/05/2026).
   * Refraîchi par MechanicalTradingService à chaque cycle 60s.
   */
  private protectedSymbols = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    /** Optional pour back-compat tests : runtime prod l'injecte toujours. */
    @Optional() private readonly supabase?: SupabaseService,
  ) {}

  /**
   * Met à jour la liste des symbols protégés contre l'auto-blacklist.
   * Peut être appelée manuellement (test) — sinon refresh automatique 60s.
   */
  setProtectedSymbols(symbols: string[]): void {
    this.protectedSymbols = new Set(symbols.map((s) => s.toUpperCase()));
  }

  /**
   * Cron 60s — refresh la whitelist depuis lisa_positions (status='open').
   * Self-contained, pas besoin de plomberie depuis MechanicalTradingService.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async refreshProtectedSymbols(): Promise<void> {
    if (!this.supabase || !this.supabase.isReady()) return;
    try {
      const { data } = await this.supabase.getClient()
        .from('lisa_positions')
        .select('symbol')
        .eq('status', 'open')
        .limit(200);
      const symbols = (data ?? []).map((p: { symbol: string }) => p.symbol);
      const before = this.protectedSymbols.size;
      this.setProtectedSymbols(symbols);
      if (before !== this.protectedSymbols.size) {
        this.logger.log(`[ticker-blacklist] protected symbols refreshed : ${before} → ${this.protectedSymbols.size}`);
      }
    } catch (e) {
      this.logger.debug(`[ticker-blacklist] refresh protected failed: ${String(e).slice(0, 120)}`);
    }
  }

  /**
   * True si le ticker doit être skip (blacklist statique OU dynamique active).
   * Vérifie l'expiration TTL au passage (lazy cleanup).
   */
  isBlacklisted(ticker: string, now: number = Date.now()): boolean {
    if (!ticker) return false;
    const upper = ticker.toUpperCase();
    if (this.isStaticEnabled() && DEAD_NSE_TICKERS.has(upper)) {
      return true;
    }
    const rec = this.records.get(upper);
    if (!rec?.blacklistedUntilMs) return false;
    if (rec.blacklistedUntilMs <= now) {
      // TTL expiré — purge et autorise un nouvel essai
      delete rec.blacklistedUntilMs;
      rec.strikes = [];
      return false;
    }
    return true;
  }

  /**
   * True UNIQUEMENT si blacklist STATIQUE (ticker confirmé mort sur TOUS les
   * providers, ex .NSE 404 permanent). N'inclut PAS la blacklist dynamique.
   *
   * Fix 04/06/2026 — La blacklist dynamique compte des strikes EODHD
   * HTTP_200_EMPTY. Or EODHD est cassé sur l'intraday Asia (SHE/SHG/KO/KQ/TSE)
   * alors que TwelveData fonctionne pour ces mêmes tickers. Bloquer TD sur un
   * strike EODHD verrouillait tout le flux Asia (068290.KO, 3336.HK, etc.
   * jamais évalués → 0 open). Le caller (IntradayProviderRouter) doit skip TD
   * UNIQUEMENT sur la blacklist statique, pas dynamique : si EODHD est down,
   * TD devient le fallback essentiel, pas un call à éviter.
   */
  isStaticBlacklisted(ticker: string): boolean {
    if (!ticker) return false;
    if (!this.isStaticEnabled()) return false;
    return DEAD_NSE_TICKERS.has(ticker.toUpperCase());
  }

  /**
   * Enregistre un strike 404 pour ce ticker. Si le compteur sur la fenêtre
   * 24h glissante atteint le seuil, blackliste pour TTL_HOURS.
   *
   * Le ticker statique n'a pas besoin de strikes — il est déjà blacklisté.
   * Mais on garde le no-op pour ne pas surprendre le caller.
   */
  recordStrike(ticker: string, reason = 'HTTP_404', now: number = Date.now()): void {
    if (!ticker) return;
    const upper = ticker.toUpperCase();
    // Hotfix 25/05 — skip auto-blacklist si le ticker est en position ouverte.
    // Sinon on perd l'accès EODHD pour nos holdings (bug LSE/Euronext :
    // EODHD intraday renvoie HTTP_200_EMPTY ces jours-ci → 3 strikes en
    // quelques minutes → blacklist 24h → plus de fallback price possible).
    if (this.protectedSymbols.has(upper)) {
      this.logger.debug(`[ticker-blacklist] ${upper} strike ignored (protected — open position)`);
      return;
    }
    const threshold = this.strikesThreshold();
    const windowMs = STRIKE_WINDOW_HOURS * 3600 * 1000;
    const ttlMs = this.ttlHours() * 3600 * 1000;

    let rec = this.records.get(upper);
    if (!rec) {
      rec = { strikes: [] };
      this.records.set(upper, rec);
    }
    // Purge old strikes (> 24h)
    rec.strikes = rec.strikes.filter((ts) => now - ts < windowMs);
    rec.strikes.push(now);
    // Cap memory : max 10 strikes retenues (au-delà le seuil est de toute façon dépassé)
    if (rec.strikes.length > 10) rec.strikes = rec.strikes.slice(-10);
    rec.lastReason = reason;

    if (rec.strikes.length >= threshold && !rec.blacklistedUntilMs) {
      rec.blacklistedUntilMs = now + ttlMs;
      this.logger.warn(
        `[ticker-blacklist] ${upper} auto-blacklisted (${rec.strikes.length} strikes/${threshold} in ${STRIKE_WINDOW_HOURS}h, reason=${reason}) for ${this.ttlHours()}h`,
      );
    }
  }

  /** Force-clear (test helper, ou maintenance manuelle). */
  clear(): void {
    this.records.clear();
  }

  /** Compteur dynamique courant pour un ticker (debug / test). */
  strikeCount(ticker: string, now: number = Date.now()): number {
    const rec = this.records.get(ticker.toUpperCase());
    if (!rec) return 0;
    const windowMs = STRIKE_WINDOW_HOURS * 3600 * 1000;
    return rec.strikes.filter((ts) => now - ts < windowMs).length;
  }

  /** Snapshot pour endpoint debug / log periodique. */
  getStats(): BlacklistStats {
    let dynamicCount = 0;
    for (const rec of this.records.values()) {
      if (rec.blacklistedUntilMs && rec.blacklistedUntilMs > Date.now()) dynamicCount++;
    }
    return {
      staticEnabled: this.isStaticEnabled(),
      staticSize: DEAD_NSE_TICKERS.size,
      dynamicCount,
      strikesThreshold: this.strikesThreshold(),
      ttlHours: this.ttlHours(),
    };
  }

  private isStaticEnabled(): boolean {
    const raw = this.config.get<string>('GAINERS_NSE_BLACKLIST_ENABLED');
    if (raw == null) return true;
    return String(raw).toLowerCase() === 'true';
  }

  private strikesThreshold(): number {
    const raw = this.config.get<string>('GAINERS_AUTO_BLACKLIST_404_STRIKES');
    const n = raw != null ? Number(raw) : DEFAULT_STRIKES;
    if (!Number.isFinite(n) || n < 1) return DEFAULT_STRIKES;
    return Math.min(Math.max(1, Math.floor(n)), 100);
  }

  private ttlHours(): number {
    const raw = this.config.get<string>('GAINERS_AUTO_BLACKLIST_TTL_HOURS');
    const n = raw != null ? Number(raw) : DEFAULT_TTL_HOURS;
    if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_HOURS;
    return Math.min(Math.max(0.5, n), 24 * 14); // cap 2 weeks
  }
}
