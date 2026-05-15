import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEAD_NSE_TICKERS } from '@smartvest/ai-analyst';

/**
 * Bug #R10 — Blacklist tickers EODHD morts (HTTP 404 persistant).
 *
 * Deux niveaux :
 *   1. Statique : 9 tickers `.NSE` confirmés morts depuis ≥ 7 jours (mesure
 *      15/05/2026, ~81k calls EODHD gaspillés sur la fenêtre). Liste exportée
 *      par `@smartvest/ai-analyst` (DEAD_NSE_TICKERS).
 *   2. Dynamique : compteur de strikes 404 par ticker sur fenêtre glissante 24h.
 *      Au-delà du seuil (`GAINERS_AUTO_BLACKLIST_404_STRIKES`, default 3) → ban
 *      pour `GAINERS_AUTO_BLACKLIST_TTL_HOURS` heures (default 24).
 *
 * Stockage MVP : in-memory Map. Phase MESURE active jusqu'au 17/05 — pas
 * d'ALTER TABLE Supabase ce sprint. La perte de l'état au restart Fly est
 * tolérable : la liste statique des 9 tickers évite les 9 leaks de référence,
 * et un strike-counter en mémoire reconverge en quelques cycles.
 *
 * Env vars :
 *   - GAINERS_NSE_BLACKLIST_ENABLED       (default true)
 *   - GAINERS_AUTO_BLACKLIST_404_STRIKES  (default 3)
 *   - GAINERS_AUTO_BLACKLIST_TTL_HOURS    (default 24)
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

  constructor(private readonly config: ConfigService) {}

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
   * Enregistre un strike 404 pour ce ticker. Si le compteur sur la fenêtre
   * 24h glissante atteint le seuil, blackliste pour TTL_HOURS.
   *
   * Le ticker statique n'a pas besoin de strikes — il est déjà blacklisté.
   * Mais on garde le no-op pour ne pas surprendre le caller.
   */
  recordStrike(ticker: string, reason = 'HTTP_404', now: number = Date.now()): void {
    if (!ticker) return;
    const upper = ticker.toUpperCase();
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
