/**
 * Phase D-1 — Event-driven engine SCAFFOLD.
 *
 * Cron toutes les minutes : récupère les events `eodhd_economic_events` à
 * venir dans la prochaine fenêtre [now, now + watchHorizonMin]. Pour chaque
 * event match'é par `categorizeEvent` :
 *   - INSERT row `event_engine_trades` (status='scheduled') si pas déjà tracé
 *   - À T-5min : capture snapshot prix (status='pre_snapshot')
 *
 * V1 (D-1) : limité au scheduling + snapshot. PAS de trigger ni d'exécution
 * (deferred D-2/D-3). Aucune position ouverte.
 *
 * Env-gated EVENT_ENGINE_ENABLED (default false). Sans flag, aucun cron actif,
 * aucune écriture, aucun appel API.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { LisaService } from './lisa.service';
import { categorizeEvent, EventCategory } from './event-engine.config';

interface EconomicEvent {
  event_name: string;
  country: string;
  event_date: string;  // ISO
  importance: string | null;
}

interface ScheduledTrade {
  id: number;
  event_name: string;
  event_country: string;
  event_date: string;
  symbol: string;
  status: string;
  snapshot_price: number | null;
  snapshot_taken_at: string | null;
}

const WATCH_HORIZON_MIN = 30;        // Scout events dans les 30 prochaines min
const PRE_SNAPSHOT_OFFSET_MIN = 5;   // Snapshot prix T-5min

@Injectable()
export class EventEngineService {
  private readonly logger = new Logger(EventEngineService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly lisa: LisaService,
  ) {
    this.enabled = (this.config.get<string>('EVENT_ENGINE_ENABLED') ?? 'false').toLowerCase() === 'true';
    if (this.enabled) this.logger.log('[event-engine] ENABLED (cron */1min — V1 scheduling+snapshot only)');
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Cron toutes les minutes. */
  @Cron(CronExpression.EVERY_MINUTE)
  async cronTick(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.tick();
    } catch (e) {
      this.logger.warn(`[event-engine] cron tick failed: ${String(e).slice(0, 200)}`);
    }
  }

  /** Visible pour tests/CLI. */
  async tick(): Promise<{ scheduled: number; snapshotsTaken: number }> {
    if (!this.supabase.isReady()) return { scheduled: 0, snapshotsTaken: 0 };
    const now = new Date();

    // 1. Schedule events à venir (next 30min, importance high/medium)
    const scheduled = await this.scheduleUpcomingEvents(now);

    // 2. Take snapshots pour events à T-5min
    const snapshotsTaken = await this.takePreSnapshots(now);

    return { scheduled, snapshotsTaken };
  }

  /**
   * Lit eodhd_economic_events, match les patterns, insert dans event_engine_trades
   * (status=scheduled) si pas déjà connu.
   */
  private async scheduleUpcomingEvents(now: Date): Promise<number> {
    const horizonEnd = new Date(now.getTime() + WATCH_HORIZON_MIN * 60_000);
    const { data: events, error } = await this.supabase
      .getClient()
      .from('eodhd_economic_events')
      .select('event_name, country, event_date, importance')
      .gte('event_date', now.toISOString())
      .lte('event_date', horizonEnd.toISOString())
      .in('importance', ['high', 'medium']);
    if (error || !events) return 0;

    let scheduled = 0;
    for (const ev of events as EconomicEvent[]) {
      const cat = categorizeEvent(ev.event_name);
      if (!cat) continue;
      for (const symbol of cat.watch) {
        // INSERT idempotent via UNIQUE constraint (event_name, country, date, symbol)
        const { error: insErr } = await this.supabase.getClient()
          .from('event_engine_trades')
          .insert({
            event_name: ev.event_name,
            event_country: ev.country,
            event_date: ev.event_date,
            event_importance: ev.importance,
            symbol,
            status: 'scheduled',
            raw_payload: { category_type: cat.type, tp_pct: cat.tpPct, sl_pct: cat.slPct, window_min: cat.windowMin },
          });
        // Conflict 23505 = déjà scheduled, on ignore. Autre erreur = log.
        if (insErr && !insErr.message.includes('duplicate') && !insErr.message.includes('23505')) {
          this.logger.debug(`[event-engine] schedule ${ev.event_name}/${symbol} failed: ${insErr.message}`);
        } else if (!insErr) {
          scheduled++;
          this.logger.log(`[event-engine] scheduled ${symbol} for "${ev.event_name}" at ${ev.event_date.slice(0, 16)}Z`);
        }
      }
    }
    return scheduled;
  }

  /**
   * Pour chaque trade status='scheduled' dont l'event est dans [now, now+5min],
   * capture le prix snapshot et update status='pre_snapshot'.
   */
  private async takePreSnapshots(now: Date): Promise<number> {
    const snapshotWindowEnd = new Date(now.getTime() + PRE_SNAPSHOT_OFFSET_MIN * 60_000);
    const { data: rows, error } = await this.supabase
      .getClient()
      .from('event_engine_trades')
      .select('id, event_name, event_country, event_date, symbol, status, snapshot_price, snapshot_taken_at')
      .eq('status', 'scheduled')
      .gte('event_date', now.toISOString())
      .lte('event_date', snapshotWindowEnd.toISOString())
      .limit(50);
    if (error || !rows || rows.length === 0) return 0;

    let taken = 0;
    for (const row of rows as ScheduledTrade[]) {
      const quote = await this.lisa.getLivePrice(row.symbol).catch(() => null);
      if (!quote) continue;
      const priceNum = typeof quote.price === 'number' ? quote.price : Number(quote.price);
      if (!Number.isFinite(priceNum) || priceNum <= 0) continue;
      // Skip fallback price (cf. CLAUDE.md anti-fallback rule)
      if (typeof quote.source === 'string' && quote.source.startsWith('fallback')) continue;

      const { error: updErr } = await this.supabase.getClient()
        .from('event_engine_trades')
        .update({
          status: 'pre_snapshot',
          snapshot_price: priceNum,
          snapshot_taken_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (!updErr) {
        taken++;
        this.logger.log(`[event-engine] snapshot ${row.symbol} @ ${priceNum} for "${row.event_name}"`);
      }
    }
    return taken;
  }

  /**
   * Endpoint helper : liste les events scheduled/snapshotés des prochaines
   * `withinHours` heures pour visu / debug.
   */
  async listUpcoming(withinHours = 48): Promise<unknown[]> {
    if (!this.supabase.isReady()) return [];
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() + withinHours * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('event_engine_trades')
      .select('event_name, event_country, event_date, event_importance, symbol, status, snapshot_price, snapshot_taken_at, raw_payload')
      .gte('event_date', now)
      .lte('event_date', cutoff)
      .order('event_date', { ascending: true });
    if (error || !data) return [];
    return data;
  }
}
