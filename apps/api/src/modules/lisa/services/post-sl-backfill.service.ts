import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { IntradayProviderRouter } from './intraday-provider-router.service';
import {
  computePostSlAnalysis,
  type OhlcCandle,
  type PostSlAnalysis,
} from './post-sl-analysis.helper';

/**
 * PR #292 — Backfill `lisa_positions.post_sl_path` JSONB pour les closed_stop.
 *
 * Refetch EODHD :
 *   - 1m candles sur [exit_timestamp, exit_timestamp + 30min] → analyse rebound
 *   - 5m candles sur [exit_timestamp - 75min, exit_timestamp] → ATR(14) prior
 *
 * Limites :
 *   - EODHD intraday 1m retention ~2 jours sur plan standard. Au-delà → null.
 *   - 5m retention 5 jours.
 *   - Trades > 5j ne pourront pas avoir le post_sl_path complet.
 *
 * Endpoint POST /lisa/positions/:id/backfill-post-sl-path déclenche row-by-row.
 * Pour batch backfill, le caller (script ou cron) itère sur closed_stop pending.
 */
@Injectable()
export class PostSlBackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PostSlBackfillService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eodhd: EodhdIntradayService,
    // PR #353 — Router intraday. Tous les call sites de ce service utilisent
    // fromTs/toTs → router branche EODHD-only (TD wrapper ne supporte pas
    // time-range arbitraire), mais l'unification API permet logging structuré
    // et bascule future si TD ajoute le support.
    private readonly intradayRouter: IntradayProviderRouter,
  ) {}

  /**
   * PR #293 — Auto-trigger backfill on app bootstrap quand env var set.
   *
   * Use case : user n'a pas accès flyctl SSH ni curl auth pour déclencher
   * manuellement le backfill batch. Mécanisme :
   *
   *   1. flyctl secrets set RUN_BACKFILL_POST_SL_ON_BOOT=true -a smartvest
   *   2. Fly redéploie automatiquement → app reboot
   *   3. NestJS appelle onApplicationBootstrap() → backfill tourne 1×
   *   4. Logs Fly : `[post-sl-backfill] auto-boot done: {processed, succeeded, failed}`
   *   5. flyctl secrets unset RUN_BACKFILL_POST_SL_ON_BOOT (sinon reboot suivant
   *      retriggère mais re-process des rows déjà fait = no-op grâce à
   *      `is('post_sl_path', null)` filter, donc safe mais inutile)
   *
   * Cap configurable via RUN_BACKFILL_POST_SL_LIMIT (default 100).
   * Portfolio configurable via RUN_BACKFILL_POST_SL_PORTFOLIO_ID (default
   * tous les portfolios).
   *
   * Non-bloquant : ne crash pas l'app si erreur. Log warn + continue.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.RUN_BACKFILL_POST_SL_ON_BOOT !== 'true') return;
    const limit = Math.max(1, Math.min(500, Number(process.env.RUN_BACKFILL_POST_SL_LIMIT) || 100));
    const portfolioId = process.env.RUN_BACKFILL_POST_SL_PORTFOLIO_ID;
    this.logger.log(
      `[post-sl-backfill] auto-boot triggered: limit=${limit} portfolioId=${portfolioId ?? 'all'}`,
    );
    try {
      const result = portfolioId
        ? await this.backfillBatch({ limit, portfolioId })
        : await this.backfillBatch({ limit });
      this.logger.log(`[post-sl-backfill] auto-boot done: ${JSON.stringify(result)}`);
    } catch (e) {
      this.logger.warn(`[post-sl-backfill] auto-boot failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Backfill une seule position. Retourne le résultat ou error.
   * Idempotent : si post_sl_path déjà populé, skip et return existant.
   */
  async backfillOne(positionId: string, force = false): Promise<{
    ok: boolean;
    analysis?: PostSlAnalysis;
    error?: string;
  }> {
    const { data: pos, error: fetchErr } = await this.supabase.getClient()
      .from('lisa_positions')
      .select('id, symbol, status, exit_price, exit_timestamp, post_sl_path, direction')
      .eq('id', positionId)
      .single();

    if (fetchErr || !pos) {
      return { ok: false, error: `position_not_found: ${fetchErr?.message ?? 'no_row'}` };
    }
    if (pos.status !== 'closed_stop') {
      return { ok: false, error: 'not_closed_stop' };
    }
    if (pos.post_sl_path && !force) {
      return { ok: true, error: 'already_backfilled' };
    }
    if (!pos.exit_timestamp || !pos.exit_price) {
      return { ok: false, error: 'missing_exit_data' };
    }

    const exitPrice = Number(pos.exit_price);
    const exitTs = Math.floor(new Date(pos.exit_timestamp as string).getTime() / 1000);
    const direction = (pos.direction as 'long' | 'short' | null) ?? 'long';

    // Fetch 1m post-SL : window = [exitTs, exitTs + 30min + 60s buffer]
    const postFromTs = exitTs;
    const postToTs = exitTs + 30 * 60 + 60;
    // PR #353 — router (EODHD-only car fromTs/toTs présents, log structuré).
    const seriesPost = await this.intradayRouter
      .getCandles(String(pos.symbol), '1m', 35, {
        fromTs: postFromTs,
        toTs: postToTs,
        calledBy: 'post_sl_backfill',
      })
      .catch(() => null);

    if (!seriesPost || seriesPost.candles.length === 0) {
      const errBlob = {
        error: 'eodhd_post_sl_empty',
        fetched_at: new Date().toISOString(),
      };
      await this.supabase.getClient()
        .from('lisa_positions')
        .update({ post_sl_path: errBlob })
        .eq('id', positionId);
      return { ok: false, error: 'eodhd_post_sl_empty' };
    }

    const candlesPostSl: OhlcCandle[] = seriesPost.candles
      .filter((c) => c.timestamp >= exitTs && c.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    // Fetch 5m prior ATR : window = [exitTs - 75min, exitTs]
    // 14 ATR periods × 5min = 70min, +5min buffer
    const priorFromTs = exitTs - 75 * 60;
    const priorToTs = exitTs;
    // PR #353 — router (EODHD-only car fromTs/toTs présents).
    const seriesPrior = await this.intradayRouter
      .getCandles(String(pos.symbol), '5m', 20, {
        fromTs: priorFromTs,
        toTs: priorToTs,
        calledBy: 'post_sl_backfill',
      })
      .catch(() => null);

    const candlesPriorAtr: OhlcCandle[] = seriesPrior?.candles
      .filter((c) => c.close > 0)
      .sort((a, b) => a.timestamp - b.timestamp) ?? [];

    const analysis = computePostSlAnalysis({
      exitPrice,
      exitTimestamp: exitTs,
      direction,
      candlesPostSl,
      candlesPriorAtr,
    });

    const persistBlob = {
      ...analysis,
      exit_price: exitPrice,
      direction,
      candles_1m: candlesPostSl.slice(0, 30),  // store max 30 candles raw
      fetched_at: new Date().toISOString(),
    };

    await this.supabase.getClient()
      .from('lisa_positions')
      .update({ post_sl_path: persistBlob })
      .eq('id', positionId);

    this.logger.log(
      `[post-sl-backfill] ${pos.symbol} pos=${positionId.slice(0, 8)}: ` +
      `dd=${analysis.max_drawdown_post_sl_pct} recovery=${analysis.max_recovery_post_sl_pct} ` +
      `rebound50=${analysis.rebound_to_50pct_within_30min} atr=${analysis.atr_14_at_exit_pct} ` +
      `dd_in_atr=${analysis.drawdown_in_atr_units}`,
    );

    return { ok: true, analysis };
  }

  /**
   * Batch : backfill toutes les closed_stop sans post_sl_path,
   * limit configurable (default 10 pour ne pas saturer EODHD quota).
   */
  async backfillBatch(opts: { limit?: number; portfolioId?: string } = {}): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    const limit = opts.limit ?? 10;
    let query = this.supabase.getClient()
      .from('lisa_positions')
      .select('id')
      .eq('status', 'closed_stop')
      .is('post_sl_path', null)
      .order('exit_timestamp', { ascending: false })
      .limit(limit);
    if (opts.portfolioId) {
      query = query.eq('portfolio_id', opts.portfolioId);
    }
    const { data: rows, error } = await query;
    if (error || !rows) {
      this.logger.warn(`[post-sl-backfill] batch query failed: ${error?.message ?? 'no_data'}`);
      return { processed: 0, succeeded: 0, failed: 0 };
    }
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await this.backfillOne(String(row.id));
      if (result.ok) succeeded++; else failed++;
    }
    return { processed: rows.length, succeeded, failed };
  }
}
