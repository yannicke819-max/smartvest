/**
 * EodhdEconomicEventsService — cron quotidien qui pull les macro events
 * (FOMC, ECB, BoJ, PBoC, NFP, PCE, CPI, GDP, ...) sur la fenêtre J → J+7.
 *
 * Endpoint EODHD : GET /api/economic-events?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   &importance=high,medium&fmt=json
 *
 * Persistance dans `eodhd_economic_events` (UPSERT). Cible :
 *   - couverture macro Asie + EU + US (résout partiellement le trou news
 *     ticker-spécifique pour Asia/EU).
 *   - alimente le brief Gemini Phase 1bis avec data vérifiée.
 *
 * Gating : `EODHD_ECONOMIC_EVENTS_ENABLED` (default false). Sans flag, aucun
 * appel API, aucune écriture.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';

interface RawEconomicEvent {
  type?: string;
  comparison?: string;
  country?: string;
  date?: string;
  actual?: number | string | null;
  previous?: number | string | null;
  estimate?: number | string | null;
  unit?: string;
  importance?: string;
}

export interface PersistedEconomicEvent {
  event_name: string;
  country: string;
  event_date: string;
  importance: string | null;
  actual: number | null;
  previous: number | null;
  estimate: number | null;
  unit: string | null;
}

const EODHD_ECON_BASE = 'https://eodhd.com/api/economic-events';
const FETCH_TIMEOUT_MS = 15_000;

@Injectable()
export class EodhdEconomicEventsService {
  private readonly logger = new Logger(EodhdEconomicEventsService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.enabled = (this.config.get<string>('EODHD_ECONOMIC_EVENTS_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) this.logger.log('[eodhd-economic-events] ENABLED (cron daily 03:30 UTC)');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  static parseNum(v: number | string | null | undefined): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[,%KMB]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  static toRow(raw: RawEconomicEvent): PersistedEconomicEvent | null {
    if (!raw.date || !raw.type || !raw.country) return null;
    return {
      event_name: raw.type.slice(0, 200),
      country: raw.country.slice(0, 8),
      event_date: new Date(raw.date).toISOString(),
      importance: raw.importance ?? null,
      actual: this.parseNum(raw.actual),
      previous: this.parseNum(raw.previous),
      estimate: this.parseNum(raw.estimate),
      unit: raw.unit ?? null,
    };
  }

  /** 03:30 UTC daily — avant le brief Gemini (04:00 UTC). */
  @Cron('30 3 * * *', { timeZone: 'UTC' })
  async cronDailyPull(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.pullAndPersist();
    } catch (e) {
      this.logger.warn(`[eodhd-economic-events] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** Pull la fenêtre [today, today+windowDays] (default 7). Visible pour tests. */
  async pullAndPersist(windowDays = 7): Promise<{ fetched: number; persisted: number }> {
    if (!this.enabled) return { fetched: 0, persisted: 0 };
    const apiKey = this.config.get<string>('EODHD_API_KEY');
    if (!apiKey || apiKey === 'demo') return { fetched: 0, persisted: 0 };

    const today = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + windowDays * 86_400_000).toISOString().slice(0, 10);
    const url =
      `${EODHD_ECON_BASE}?from=${today}&to=${to}` +
      `&importance=high,medium&api_token=${encodeURIComponent(apiKey)}&fmt=json&limit=1000`;

    let raw: unknown;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        this.logger.warn(`[eodhd-economic-events] HTTP ${res.status}`);
        return { fetched: 0, persisted: 0 };
      }
      raw = await res.json();
    } catch (e) {
      this.logger.warn(`[eodhd-economic-events] fetch err: ${String(e).slice(0, 200)}`);
      return { fetched: 0, persisted: 0 };
    }

    if (!Array.isArray(raw)) return { fetched: 0, persisted: 0 };
    const events = raw as RawEconomicEvent[];
    const rows = events
      .map((e) => EodhdEconomicEventsService.toRow(e))
      .filter((r): r is PersistedEconomicEvent => r !== null);
    if (rows.length === 0 || !this.supabase.isReady()) {
      return { fetched: events.length, persisted: 0 };
    }

    const { error } = await this.supabase
      .getClient()
      .from('eodhd_economic_events')
      .upsert(rows, { onConflict: 'country,event_name,event_date', ignoreDuplicates: true });
    if (error) {
      this.logger.warn(`[eodhd-economic-events] upsert failed: ${error.message}`);
      return { fetched: events.length, persisted: 0 };
    }
    this.logger.log(`[eodhd-economic-events] fetched=${events.length} persisted=${rows.length}`);
    return { fetched: events.length, persisted: rows.length };
  }

  /** Lit les events des prochaines `windowHours` heures (default 48h). */
  async getUpcomingEvents(windowHours = 48): Promise<PersistedEconomicEvent[]> {
    if (!this.supabase.isReady()) return [];
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() + windowHours * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('eodhd_economic_events')
      .select('event_name, country, event_date, importance, actual, previous, estimate, unit')
      .gte('event_date', now)
      .lte('event_date', cutoff)
      .order('event_date', { ascending: true })
      .limit(50);
    if (error || !data) return [];
    return data as PersistedEconomicEvent[];
  }
}
