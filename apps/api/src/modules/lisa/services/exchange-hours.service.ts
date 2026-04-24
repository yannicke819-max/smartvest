import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * ExchangeHoursService — détermine si un symbole peut être tradé à un
 * instant donné, en fonction de la classe d'actif et du marché d'origine.
 *
 * Horaires :
 * - Crypto : 24/7, toujours ouvert.
 * - FX majeurs : dimanche 21:00 UTC → vendredi 22:00 UTC (fermé weekend).
 * - Equity/ETF US : lundi-vendredi 14:30-21:00 UTC (regular session NYSE/NASDAQ).
 * - Bonds US : lundi-vendredi 13:00-22:00 UTC.
 * - Commodities ETFs : alignés sur US equity (traités comme ETF US).
 *
 * Jours fériés US : rafraîchis dynamiquement au boot et toutes les 24h
 * via /api/exchange-details/US (EODHD). Fallback sur une liste hardcodée
 * 2026 si l'API indispo (offline safe).
 *
 * Fournit aussi une estimation "minutes avant ouverture/fermeture" pour
 * que Lisa puisse anticiper un catalyseur (ex : éviter d'ouvrir SPY à
 * 20h59 UTC juste avant la cloche).
 */

export interface MarketState {
  symbol: string;
  assetClass: string;
  isOpen: boolean;
  reason: 'open' | 'weekend' | 'afterhours' | 'premarket' | 'holiday' | 'always_open';
  nextOpenMinutes: number | null; // minutes avant prochaine ouverture, null si déjà ouvert
  nextCloseMinutes: number | null; // minutes avant prochaine clôture, null si fermé
}

// Jours fériés US — liste hardcodée 2026 utilisée en fallback si l'API
// EODHD /exchange-details/US est indispo. Le loader dynamique remplit
// `usHolidays` au boot ; si ça échoue on utilise cette liste.
const US_HOLIDAYS_FALLBACK_2026 = new Set([
  '2026-01-01', // New Year
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

@Injectable()
export class ExchangeHoursService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeHoursService.name);
  private usHolidays: Set<string> = new Set(US_HOLIDAYS_FALLBACK_2026);
  private holidaysLoadedFromApi = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Non-bloquant : chargement au boot + refresh toutes les 24h
    setImmediate(() => this.refreshHolidays().catch(() => void 0));
    setInterval(() => this.refreshHolidays().catch(() => void 0), 24 * 60 * 60 * 1000).unref();
  }

  private apiKey(): string | null {
    const k = this.config.get<string>('EODHD_API_KEY');
    return k && k !== 'demo' ? k : null;
  }

  /**
   * Charge les jours fériés US depuis EODHD /exchange-details/US.
   * Format de réponse (condensé) :
   *   { ExchangeHolidays: { Holiday_1: { Date: "2026-01-01", Type: "public_holiday", ... }, ... } }
   * En cas d'échec, on garde le fallback hardcodé — pas de downgrade de sécurité.
   */
  private async refreshHolidays(): Promise<void> {
    const key = this.apiKey();
    if (!key) return;
    try {
      const url = `https://eodhd.com/api/exchange-details/US?api_token=${encodeURIComponent(key)}&fmt=json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        this.logger.warn(`exchange-details/US HTTP ${res.status} — fallback holidays restent actifs`);
        return;
      }
      const data = await res.json() as { ExchangeHolidays?: Record<string, { Date?: string }> };
      const map = data?.ExchangeHolidays;
      if (!map || typeof map !== 'object') return;

      const fresh = new Set<string>();
      for (const h of Object.values(map)) {
        const d = h?.Date;
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) fresh.add(d);
      }
      if (fresh.size > 0) {
        this.usHolidays = fresh;
        this.holidaysLoadedFromApi = true;
        this.logger.log(`Holidays US refreshed from EODHD: ${fresh.size} entries`);
      }
    } catch (e) {
      this.logger.warn(`exchange-details/US fetch failed: ${String(e).slice(0, 100)} — fallback actif`);
    }
  }

  private isUsHoliday(dateStr: string): boolean {
    return this.usHolidays.has(dateStr);
  }

  getMarketState(symbol: string, assetClass: string): MarketState {
    const now = new Date();
    const dow = now.getUTCDay(); // 0=dim, 6=sam
    const utcH = now.getUTCHours();
    const utcM = now.getUTCMinutes();
    const minuteOfDay = utcH * 60 + utcM;
    const dateStr = now.toISOString().slice(0, 10);

    const cls = assetClass.toLowerCase();

    // Crypto : 24/7
    if (cls.includes('crypto') || cls === 'stablecoin') {
      return { symbol, assetClass, isOpen: true, reason: 'always_open', nextOpenMinutes: null, nextCloseMinutes: null };
    }

    // FX : dimanche 21:00 UTC → vendredi 22:00 UTC
    if (cls.includes('fx') || cls.includes('forex')) {
      const fxOpen =
        (dow === 0 && minuteOfDay >= 21 * 60) ||
        (dow >= 1 && dow <= 4) ||
        (dow === 5 && minuteOfDay < 22 * 60);
      if (fxOpen) {
        return { symbol, assetClass, isOpen: true, reason: 'open', nextOpenMinutes: null, nextCloseMinutes: null };
      }
      return { symbol, assetClass, isOpen: false, reason: 'weekend', nextOpenMinutes: this.minutesUntilFxOpen(now), nextCloseMinutes: null };
    }

    // Jours fériés US → equities/ETFs/bonds fermés
    if (this.isUsHoliday(dateStr)) {
      return { symbol, assetClass, isOpen: false, reason: 'holiday', nextOpenMinutes: this.minutesUntilNextUsEquityOpen(now), nextCloseMinutes: null };
    }

    // Weekend → fermé pour tout ce qui est US
    if (dow === 0 || dow === 6) {
      return { symbol, assetClass, isOpen: false, reason: 'weekend', nextOpenMinutes: this.minutesUntilNextUsEquityOpen(now), nextCloseMinutes: null };
    }

    // Semaine, ouverture US selon asset class
    // Equity/ETF/Commodities ETFs + dérivés vol (VIXY/UVXY) + hedge : 14:30-21:00 UTC
    // La liste couvre les classes que Lisa émet régulièrement (equity_us_small,
    // commodities_metals_precious, derivatives_vol, etc.).
    const isUsHoursClass =
      cls.includes('equity') ||
      cls.includes('etf') ||
      cls.includes('commodities') ||
      cls.includes('commodity') ||
      cls.includes('stock') ||
      cls === 'index' ||
      cls.includes('derivatives') ||
      cls.includes('volatility') ||
      cls.includes('vol') ||
      cls.includes('hedge') ||
      cls.includes('option');
    if (isUsHoursClass) {
      const openMin = 14 * 60 + 30;
      const closeMin = 21 * 60;
      if (minuteOfDay >= openMin && minuteOfDay < closeMin) {
        return { symbol, assetClass, isOpen: true, reason: 'open', nextOpenMinutes: null, nextCloseMinutes: closeMin - minuteOfDay };
      }
      if (minuteOfDay < openMin) {
        return { symbol, assetClass, isOpen: false, reason: 'premarket', nextOpenMinutes: openMin - minuteOfDay, nextCloseMinutes: null };
      }
      return { symbol, assetClass, isOpen: false, reason: 'afterhours', nextOpenMinutes: this.minutesUntilNextUsEquityOpen(now), nextCloseMinutes: null };
    }

    // Bonds / govt_bonds_us : 13:00-22:00 UTC
    if (cls.includes('bond')) {
      const openMin = 13 * 60;
      const closeMin = 22 * 60;
      if (minuteOfDay >= openMin && minuteOfDay < closeMin) {
        return { symbol, assetClass, isOpen: true, reason: 'open', nextOpenMinutes: null, nextCloseMinutes: closeMin - minuteOfDay };
      }
      if (minuteOfDay < openMin) {
        return { symbol, assetClass, isOpen: false, reason: 'premarket', nextOpenMinutes: openMin - minuteOfDay, nextCloseMinutes: null };
      }
      return { symbol, assetClass, isOpen: false, reason: 'afterhours', nextOpenMinutes: this.minutesUntilNextUsEquityOpen(now), nextCloseMinutes: null };
    }

    // Default DÉFENSIF : classe inconnue → on suppose US equity hours (14:30-21:00 UTC).
    // Avant, on retournait "ouvert 24/7", ce qui laissait passer derivatives_vol
    // (VIXY) afterhours sur prix stale → ouverture dans le vide. Maintenant,
    // tout ce qui n'est pas explicitement crypto/fx/bond est aligné US equity.
    const openMin = 14 * 60 + 30;
    const closeMin = 21 * 60;
    if (minuteOfDay >= openMin && minuteOfDay < closeMin) {
      return { symbol, assetClass, isOpen: true, reason: 'open', nextOpenMinutes: null, nextCloseMinutes: closeMin - minuteOfDay };
    }
    if (minuteOfDay < openMin) {
      return { symbol, assetClass, isOpen: false, reason: 'premarket', nextOpenMinutes: openMin - minuteOfDay, nextCloseMinutes: null };
    }
    return { symbol, assetClass, isOpen: false, reason: 'afterhours', nextOpenMinutes: this.minutesUntilNextUsEquityOpen(now), nextCloseMinutes: null };
  }

  isTradable(symbol: string, assetClass: string): boolean {
    return this.getMarketState(symbol, assetClass).isOpen;
  }

  /**
   * Helper : résumé texte ultra-compact pour le briefing Lisa.
   * Ex: "MARKET_OPEN" · "CLOSED_WEEKEND_OPENS_IN_48h" · "CLOSED_AFTERHOURS_OPENS_IN_17h"
   */
  summarize(state: MarketState): string {
    if (state.isOpen) {
      if (state.nextCloseMinutes != null && state.nextCloseMinutes < 60) {
        return `OPEN (closes in ${state.nextCloseMinutes}min)`;
      }
      return 'OPEN';
    }
    const label = state.reason.toUpperCase();
    if (state.nextOpenMinutes != null) {
      const hrs = Math.floor(state.nextOpenMinutes / 60);
      const mins = state.nextOpenMinutes % 60;
      const when = hrs > 0 ? `${hrs}h${mins > 0 ? `${mins}m` : ''}` : `${mins}min`;
      return `CLOSED_${label} (opens in ${when})`;
    }
    return `CLOSED_${label}`;
  }

  private minutesUntilNextUsEquityOpen(now: Date): number {
    // Prochain jour ouvrable US, 14:30 UTC
    const target = new Date(now);
    target.setUTCHours(14, 30, 0, 0);
    // Avance jour par jour jusqu'à un jour ouvrable non férié
    for (let i = 0; i < 7; i++) {
      if (i > 0 || target.getTime() <= now.getTime()) {
        target.setUTCDate(target.getUTCDate() + 1);
        target.setUTCHours(14, 30, 0, 0);
      }
      const d = target.getUTCDay();
      const dateStr = target.toISOString().slice(0, 10);
      if (d !== 0 && d !== 6 && !this.isUsHoliday(dateStr)) {
        return Math.max(0, Math.floor((target.getTime() - now.getTime()) / 60000));
      }
    }
    return 0;
  }

  private minutesUntilFxOpen(now: Date): number {
    const target = new Date(now);
    const dow = now.getUTCDay();
    // Si samedi ou vendredi après 22:00 → dimanche 21:00
    if (dow === 6 || (dow === 5 && now.getUTCHours() >= 22)) {
      const daysUntilSunday = dow === 6 ? 1 : 2;
      target.setUTCDate(target.getUTCDate() + daysUntilSunday);
      target.setUTCHours(21, 0, 0, 0);
      return Math.max(0, Math.floor((target.getTime() - now.getTime()) / 60000));
    }
    return 0;
  }
}
