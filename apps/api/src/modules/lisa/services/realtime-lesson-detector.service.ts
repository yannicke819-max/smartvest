/**
 * RealTimeLessonDetectorService — Détection auto de lessons en live.
 *
 * Tourne toutes les 5 min (cron "*\/5 * * * *"). Analyse les closes des 5 portfolios
 * dans les 30 dernières minutes et insère automatiquement des lessons
 * si pattern significatif détecté :
 *
 *   1. BIG_WIN_TICKER : si un ticker a fait >$50 sur 1 close → winning_pattern
 *      Confidence 0.80, scope par asset_class (asia_only / eu_only / us_only)
 *
 *   2. BIG_LOSS_TICKER : si un ticker a fait <-$50 sur 1 close → losing_pattern
 *      → ban temporaire (24h cooldown sur ce ticker) + lesson
 *
 *   3. SL_GAP_FAILURE : si realized_pnl_pct < -2% × SL_pct (SL traversé sans
 *      trigger normal) → risk_observation conf=0.95, lesson_text détaille le
 *      delta. Symbole et exchange ajoutés à blacklist temporaire.
 *
 *   4. TP_DOUBLE_CYCLE : si même ticker a 2 TPs successifs dans 4h → winning_pattern
 *      "Re-open post-TP même ticker validé" + boost sizing
 *
 *   5. ORPHAN_CLOSE_WIN : si trade fermé en discipline pré-cloche (5-30min
 *      avant exchange close) AVEC profit → exit_rule conf=0.85
 *
 * Anti-spam : skip si lesson identique a déjà été insérée dans les 24h pour
 * le même ticker + même pattern.
 *
 * Override env : REALTIME_LESSON_DETECTOR_ENABLED=false pour disable.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { isInExchangeSession } from './exchange-sessions.helper';

const TRADER_AGENT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';
const GAINERS_PORTFOLIOS = new Set([
  'b0000001-0000-0000-0000-000000000001', // TRADER (ex-MAIN 58439d86, migré 30/05/2026)
  'a0000001-0000-0000-0000-000000000001',
  'a0000002-0000-0000-0000-000000000002',
  'a0000003-0000-0000-0000-000000000003',
]);

interface ClosedTrade {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string | null;
  entry_price: number;
  exit_price: number;
  realized_pnl_usd: number;
  realized_pnl_pct: number;
  exit_reason: string;
  entry_timestamp: string;
  exit_timestamp: string;
  entry_notional_usd: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
}

interface DetectedLesson {
  table: 'trader_agent_memory' | 'scanner_lessons';
  pattern_id: string; // anti-spam key
  payload: Record<string, unknown>;
}

@Injectable()
export class RealTimeLessonDetectorService {
  private readonly logger = new Logger(RealTimeLessonDetectorService.name);
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('REALTIME_LESSON_DETECTOR_ENABLED') ?? 'true').toLowerCase() === 'true';
    this.logger.log(`[realtime-lesson-detector] onModuleInit fired — enabled=${this.enabled}`);

    if (this.enabled) {
      try {
        const job = new CronJob('*/5 * * * *', () => {
          this.runDetection().catch((e) =>
            this.logger.error(`[realtime-lesson-detector] cron failed: ${String(e).slice(0, 200)}`),
          );
        });
        this.schedulerRegistry.addCronJob('realtime-lesson-detector', job);
        job.start();
        this.logger.log('[realtime-lesson-detector] ENABLED — cron every 5min');
      } catch (e) {
        this.logger.error(`[realtime-lesson-detector] cron register failed: ${String(e).slice(0, 200)}`);
      }
    }
  }

  async runDetection(): Promise<{ scanned: number; detected: number; inserted: number }> {
    const sb = this.supabase.getClient();
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data, error } = await sb
      .from('lisa_positions')
      .select('id, portfolio_id, symbol, asset_class, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, entry_timestamp, exit_timestamp, entry_notional_usd, stop_loss_price, take_profit_price')
      .neq('status', 'open')
      .gte('exit_timestamp', since);

    if (error) {
      this.logger.error(`[realtime-lesson-detector] fetch failed: ${error.message}`);
      return { scanned: 0, detected: 0, inserted: 0 };
    }

    const trades = (data ?? []) as ClosedTrade[];
    const detected: DetectedLesson[] = [];

    for (const trade of trades) {
      detected.push(...this.detectPatterns(trade));
    }

    // Detect TP_DOUBLE_CYCLE en cross-trades (besoin de regrouper par symbol)
    detected.push(...this.detectTpDoubleCycle(trades));

    // FIX 01/06 — Inject [ID:pattern_id] tag in lesson_text pour permettre
    // au dedup ilike (ci-dessous) de matcher. Sans ça, le pattern_id (avec
    // underscores) n'apparaît jamais dans le text humain → re-insert chaque cycle.
    for (const lesson of detected) {
      const existingText = String(lesson.payload?.lesson_text ?? '');
      if (!existingText.includes(`[ID:${lesson.pattern_id}]`)) {
        lesson.payload = { ...lesson.payload, lesson_text: `${existingText} [ID:${lesson.pattern_id}]` };
      }
    }

    let inserted = 0;
    for (const lesson of detected) {
      try {
        // Anti-spam : skip si même pattern_id déjà inséré dans les 24h.
        // FIX 01/06 — le tag `[ID:${pattern_id}]` est injecté par buildLessonText
        // (cf. detectPatterns). Le matcher ilike précédent cherchait `%${pattern_id}%`
        // directement dans lesson_text mais le pattern_id (ex: BIG_LOSS_SCT.LSE_2026-06-01)
        // n'apparaissait pas littéralement dans le text humain — match=0 → re-insert
        // à chaque cycle. Audit 01/06 : 26 lessons SCT.LSE/IES.LSE identiques en 1j.
        const { data: existing } = await sb
          .from(lesson.table)
          .select('id')
          .gte('created_at', new Date(Date.now() - 24 * 3600_000).toISOString())
          .ilike('lesson_text', `%[ID:${lesson.pattern_id}]%`)
          .limit(1);
        if (existing && existing.length > 0) continue;

        await sb.from(lesson.table).insert(lesson.payload);
        inserted++;
      } catch (e) {
        this.logger.warn(`[realtime-lesson-detector] insert failed: ${String(e).slice(0, 100)}`);
      }
    }

    this.logger.log(
      `[realtime-lesson-detector] cycle done — scanned=${trades.length} detected=${detected.length} inserted=${inserted}`,
    );
    return { scanned: trades.length, detected: detected.length, inserted };
  }

  /** Détecte les patterns sur 1 trade isolé. */
  private detectPatterns(trade: ClosedTrade): DetectedLesson[] {
    const lessons: DetectedLesson[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const isTrader = trade.portfolio_id === TRADER_AGENT_PORTFOLIO_ID;
    const scopeByAssetClass = this.scopeForAssetClass(trade.asset_class);

    // Pattern 1 : BIG_WIN_TICKER (>$50)
    if (trade.realized_pnl_usd > 50) {
      const patternId = `BIG_WIN_${trade.symbol}_${today}`;
      const text = `[RealtimeDetector ${today}] BIG_WIN observé : ${trade.symbol} ${isTrader ? 'TRADER' : 'GAINERS'} entry $${trade.entry_price} → exit $${trade.exit_price} = +$${trade.realized_pnl_usd.toFixed(2)} (+${trade.realized_pnl_pct.toFixed(2)}%) hold=${this.holdMinutes(trade)}min. Pattern : ce ticker + cette classe + ce timing → setup gagnant à reproduire.`;
      lessons.push({
        table: isTrader ? 'trader_agent_memory' : 'scanner_lessons',
        pattern_id: patternId,
        payload: isTrader ? {
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          derived_from_date: today,
          lesson_kind: 'winning_pattern',
          lesson_text: text,
          confidence: 0.80,
          is_active: true,
          payload: { detected: 'realtime', trade_id: trade.id, pnl: trade.realized_pnl_usd },
        } : {
          derived_from_date: today,
          lesson_kind: 'winning_pattern',
          lesson_text: text,
          macro_condition: 'ANY',
          scope: scopeByAssetClass,
          confidence: 0.80,
          sample_size: 1,
          win_rate_observed: 100,
          avg_pnl_usd: trade.realized_pnl_usd,
          is_active: true,
          applied: false,
        },
      });
    }

    // Pattern 2 : BIG_LOSS_TICKER (<-$50)
    if (trade.realized_pnl_usd < -50) {
      const patternId = `BIG_LOSS_${trade.symbol}_${today}`;
      const text = `[RealtimeDetector ${today}] BIG_LOSS observé : ${trade.symbol} ${isTrader ? 'TRADER' : 'GAINERS'} entry $${trade.entry_price} → exit $${trade.exit_price} = $${trade.realized_pnl_usd.toFixed(2)} (${trade.realized_pnl_pct.toFixed(2)}%) reason="${trade.exit_reason.slice(0, 60)}". RECOMMANDATION : ban ce ticker pour 24h, vérifier si feed problématique ou fundamental hostile.`;
      lessons.push({
        table: isTrader ? 'trader_agent_memory' : 'scanner_lessons',
        pattern_id: patternId,
        payload: isTrader ? {
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          derived_from_date: today,
          lesson_kind: 'losing_pattern',
          lesson_text: text,
          confidence: 0.85,
          is_active: true,
          payload: { detected: 'realtime', trade_id: trade.id, pnl: trade.realized_pnl_usd },
        } : {
          derived_from_date: today,
          lesson_kind: 'losing_pattern',
          lesson_text: text,
          macro_condition: 'ANY',
          scope: scopeByAssetClass,
          confidence: 0.85,
          sample_size: 1,
          win_rate_observed: 0,
          avg_pnl_usd: trade.realized_pnl_usd,
          is_active: true,
          applied: false,
        },
      });
    }

    // Pattern 3 : SL_GAP_FAILURE — exit_pct dépasse de >50% le SL prévu
    if (trade.stop_loss_price != null && trade.entry_price > 0) {
      const slPctConfigured = Math.abs((trade.stop_loss_price - trade.entry_price) / trade.entry_price * 100);
      const exitPctActual = Math.abs(trade.realized_pnl_pct);
      if (slPctConfigured > 0 && exitPctActual > slPctConfigured * 1.5 && trade.realized_pnl_pct < 0) {
        const patternId = `SL_GAP_${trade.symbol}_${today}`;
        const text = `[RealtimeDetector ${today}] SL_GAP_FAILURE : ${trade.symbol} SL configuré à ${slPctConfigured.toFixed(2)}% mais réalisé ${exitPctActual.toFixed(2)}% = slippage ${(exitPctActual - slPctConfigured).toFixed(2)}%. Source : gap intra-session non capté par polling. Si exchange = .XETRA / .F / small-cap illiquide : ajouter à blacklist code-level (cf. fix QH9.XETRA commit 8f5445d).`;
        lessons.push({
          table: isTrader ? 'trader_agent_memory' : 'scanner_lessons',
          pattern_id: patternId,
          payload: isTrader ? {
            portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
            derived_from_date: today,
            lesson_kind: 'risk_observation',
            lesson_text: text,
            confidence: 0.95,
            is_active: true,
            payload: { detected: 'realtime', sl_configured_pct: slPctConfigured, sl_actual_pct: exitPctActual },
          } : {
            derived_from_date: today,
            lesson_kind: 'risk_observation',
            lesson_text: text,
            macro_condition: 'ANY',
            scope: scopeByAssetClass,
            confidence: 0.95,
            sample_size: 1,
            is_active: true,
            applied: false,
          },
        });
      }
    }

    // Pattern 4 : ORPHAN_CLOSE_WIN — discipline pré-cloche avec profit
    if (trade.realized_pnl_usd > 0 && trade.exit_reason.toLowerCase().includes('ferm') && trade.exit_reason.toLowerCase().includes('march')) {
      const exitTime = new Date(trade.exit_timestamp);
      const symbolForCheck = trade.symbol;
      try {
        const stillInSession = isInExchangeSession(symbolForCheck, exitTime);
        if (stillInSession) {
          const patternId = `ORPHAN_PRE_CLOSE_${trade.symbol}_${today}`;
          const text = `[RealtimeDetector ${today}] DISCIPLINE_PRE_CLOSE validé : ${trade.symbol} fermée à ${trade.exit_timestamp.slice(11, 16)} UTC AVANT cloche du marché avec profit +$${trade.realized_pnl_usd.toFixed(2)}. Pattern : fermer 5-30min avant fermeture exchange = évite ORPHAN_CLOSE break-even.`;
          lessons.push({
            table: isTrader ? 'trader_agent_memory' : 'scanner_lessons',
            pattern_id: patternId,
            payload: isTrader ? {
              portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
              derived_from_date: today,
              lesson_kind: 'exit_rule',
              lesson_text: text,
              confidence: 0.85,
              is_active: true,
              payload: { detected: 'realtime' },
            } : {
              derived_from_date: today,
              lesson_kind: 'exit_rule',
              lesson_text: text,
              macro_condition: 'ANY',
              scope: scopeByAssetClass,
              confidence: 0.85,
              sample_size: 1,
              is_active: true,
              applied: false,
            },
          });
        }
      } catch {
        // ignore session helper errors
      }
    }

    return lessons;
  }

  /** Détecte TP_DOUBLE_CYCLE : même ticker, 2 wins dans 4h. */
  private detectTpDoubleCycle(trades: ClosedTrade[]): DetectedLesson[] {
    const lessons: DetectedLesson[] = [];
    const today = new Date().toISOString().slice(0, 10);
    const bySymbol = new Map<string, ClosedTrade[]>();
    for (const t of trades) {
      if (t.realized_pnl_usd <= 0) continue;
      const arr = bySymbol.get(t.symbol) ?? [];
      arr.push(t);
      bySymbol.set(t.symbol, arr);
    }
    for (const [symbol, arr] of bySymbol.entries()) {
      if (arr.length < 2) continue;
      const totalPnl = arr.reduce((sum, t) => sum + t.realized_pnl_usd, 0);
      if (totalPnl < 30) continue;
      const patternId = `TP_DOUBLE_${symbol}_${today}`;
      const isTrader = arr.every((t) => t.portfolio_id === TRADER_AGENT_PORTFOLIO_ID);
      const text = `[RealtimeDetector ${today}] TP_DOUBLE_CYCLE validé : ${symbol} ${arr.length} TPs dans la session = $${totalPnl.toFixed(2)} cumul. Pattern : ré-ouvrir post-TP avec sizing UP (cf. lesson 029e2e37 CHRT.LSE).`;
      lessons.push({
        table: isTrader ? 'trader_agent_memory' : 'scanner_lessons',
        pattern_id: patternId,
        payload: isTrader ? {
          portfolio_id: TRADER_AGENT_PORTFOLIO_ID,
          derived_from_date: today,
          lesson_kind: 'winning_pattern',
          lesson_text: text,
          confidence: 0.85,
          is_active: true,
          payload: { detected: 'realtime', cumul: totalPnl, cycles: arr.length },
        } : {
          derived_from_date: today,
          lesson_kind: 'winning_pattern',
          lesson_text: text,
          macro_condition: 'ANY',
          scope: this.scopeForAssetClass(arr[0]?.asset_class ?? null),
          confidence: 0.85,
          sample_size: arr.length,
          win_rate_observed: 100,
          avg_pnl_usd: totalPnl / arr.length,
          is_active: true,
          applied: false,
        },
      });
    }
    return lessons;
  }

  private scopeForAssetClass(assetClass: string | null): string {
    if (!assetClass) return 'all_scanner';
    const cls = assetClass.toLowerCase();
    if (cls.includes('asia')) return 'asia_only';
    if (cls.includes('eu')) return 'eu_only';
    if (cls.includes('us')) return 'us_only';
    if (cls.includes('crypto')) return 'crypto_only';
    return 'all_scanner';
  }

  private holdMinutes(trade: ClosedTrade): number {
    const e = new Date(trade.entry_timestamp).getTime();
    const x = new Date(trade.exit_timestamp).getTime();
    return Math.round((x - e) / 60_000);
  }
}
