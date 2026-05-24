/**
 * Sizing A/B Test Service — shadow tracker.
 *
 * Quand le scanner réel ouvre une position, ce service écrit en parallèle
 * jusqu'à 3 rows shadow (bucket A, B, baseline) selon la capacité dispo
 * dans chaque bucket. Plus tard, quand la position réelle se ferme, un
 * cron daily (closeMatchingShadows) mirror le PnL réel scaled au notional
 * de chaque bucket.
 *
 * Objectif : comparer Sharpe / sum_pnl / capital efficiency entre :
 *   - Bucket A — concentrated : 3 × $2800
 *   - Bucket B — diversified  : 12 × $700
 *   - Baseline (current real) : 5 × $787
 *
 * Aucun trade réel impacté. 100% shadow.
 *
 * Gating : SIZING_AB_TEST_ENABLED (default false).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../supabase/supabase.service';
import {
  parseSizingABConfig,
  decideBucketAction,
  scalePnlToBucket,
  type SizingABConfig,
  type BucketConfig,
  type BucketName,
} from './sizing-ab-test.helper';

@Injectable()
export class SizingABTestService {
  private readonly logger = new Logger(SizingABTestService.name);
  private readonly cfg: SizingABConfig;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {
    this.cfg = parseSizingABConfig({
      SIZING_AB_TEST_ENABLED: this.config.get<string>('SIZING_AB_TEST_ENABLED'),
      SIZING_AB_BUCKET_A_MAX_POS: this.config.get<string>('SIZING_AB_BUCKET_A_MAX_POS'),
      SIZING_AB_BUCKET_A_NOTIONAL: this.config.get<string>('SIZING_AB_BUCKET_A_NOTIONAL'),
      SIZING_AB_BUCKET_B_MAX_POS: this.config.get<string>('SIZING_AB_BUCKET_B_MAX_POS'),
      SIZING_AB_BUCKET_B_NOTIONAL: this.config.get<string>('SIZING_AB_BUCKET_B_NOTIONAL'),
      SIZING_AB_BASELINE_MAX_POS: this.config.get<string>('SIZING_AB_BASELINE_MAX_POS'),
      SIZING_AB_BASELINE_NOTIONAL: this.config.get<string>('SIZING_AB_BASELINE_NOTIONAL'),
    });
    if (this.cfg.enabled) {
      this.logger.log(
        `[sizing-ab] ENABLED — A=${this.cfg.bucket_a.max_positions}×$${this.cfg.bucket_a.notional_usd} ` +
        `B=${this.cfg.bucket_b.max_positions}×$${this.cfg.bucket_b.notional_usd} ` +
        `baseline=${this.cfg.bucket_baseline.max_positions}×$${this.cfg.bucket_baseline.notional_usd}`,
      );
    }
  }

  /**
   * À appeler depuis le scanner quand une position réelle vient d'être ouverte.
   * Best-effort : si échec, ne throw pas (shadow only).
   */
  async recordSignal(opts: {
    symbol: string;
    assetClass: string;
    scannerPositionId: string;
  }): Promise<void> {
    if (!this.cfg.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      // Read current open shadow positions count for each bucket (in parallel)
      const [openA, openB, openBaseline] = await Promise.all([
        this.countOpenShadow('A_concentrated'),
        this.countOpenShadow('B_diversified'),
        this.countOpenShadow('baseline'),
      ]);

      const rows = [
        this.buildSignalRow(this.cfg.bucket_a, openA, opts),
        this.buildSignalRow(this.cfg.bucket_b, openB, opts),
        this.buildSignalRow(this.cfg.bucket_baseline, openBaseline, opts),
      ];

      const { error } = await this.supabase
        .getClient()
        .from('sizing_ab_shadow_signals')
        .insert(rows);
      if (error) {
        this.logger.warn(`[sizing-ab] insert failed: ${error.message}`);
      } else {
        this.logger.log(
          `[sizing-ab] ${opts.symbol} signals : A=${rows[0].decision} B=${rows[1].decision} baseline=${rows[2].decision}`,
        );
      }
    } catch (e) {
      this.logger.warn(`[sizing-ab] recordSignal exception: ${String(e).slice(0, 200)}`);
    }
  }

  private buildSignalRow(
    bucket: BucketConfig,
    currentOpen: number,
    opts: { symbol: string; assetClass: string; scannerPositionId: string },
  ): Record<string, unknown> {
    const action = decideBucketAction(bucket, currentOpen);
    return {
      bucket: bucket.name,
      symbol: opts.symbol,
      asset_class: opts.assetClass,
      scanner_position_id: opts.scannerPositionId,
      notional_usd: bucket.notional_usd,
      capacity_at_signal: currentOpen,
      max_positions: bucket.max_positions,
      decision: action.decision,
      decision_reason: action.reason,
    };
  }

  private async countOpenShadow(bucket: BucketName): Promise<number> {
    const { count, error } = await this.supabase
      .getClient()
      .from('sizing_ab_shadow_signals')
      .select('*', { count: 'exact', head: true })
      .eq('bucket', bucket)
      .eq('decision', 'shadow_opened')
      .is('closed_at', null);
    if (error) return 0;
    return count ?? 0;
  }

  /**
   * Cron daily 04:30 UTC — mirror les closes réels vers les shadow signals.
   * Lit lisa_positions fermées dans les 24h, retrouve les shadow signals
   * matching, scale le PnL au notional du bucket et update.
   */
  @Cron('30 4 * * *', { timeZone: 'UTC' })
  async cronDailyCloseShadows(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (!this.supabase.isReady()) return;
    try {
      const cutoff = new Date(Date.now() - 36 * 3600_000).toISOString(); // 36h margin
      // 1. Find shadow signals still open (closed_at null) liées à des positions réelles fermées
      const { data: openShadows } = await this.supabase
        .getClient()
        .from('sizing_ab_shadow_signals')
        .select('id, bucket, scanner_position_id, notional_usd')
        .eq('decision', 'shadow_opened')
        .is('closed_at', null)
        .not('scanner_position_id', 'is', null)
        .gte('signal_at', cutoff)
        .limit(500);

      if (!openShadows || openShadows.length === 0) {
        this.logger.log('[sizing-ab] cronClose : aucun shadow ouvert à matcher');
        return;
      }

      const positionIds = (openShadows as Array<{ scanner_position_id: string }>)
        .map((s) => s.scanner_position_id)
        .filter(Boolean);
      const { data: realPositions } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('id, status, exit_timestamp, realized_pnl_pct')
        .in('id', positionIds)
        .neq('status', 'open')
        .not('realized_pnl_pct', 'is', null);

      if (!realPositions || realPositions.length === 0) {
        this.logger.log('[sizing-ab] cronClose : aucune position réelle fermée correspondante');
        return;
      }

      const posMap = new Map<string, { status: string; exit_timestamp: string; realized_pnl_pct: number }>();
      for (const p of realPositions as Array<{ id: string; status: string; exit_timestamp: string; realized_pnl_pct: number }>) {
        posMap.set(p.id, { status: p.status, exit_timestamp: p.exit_timestamp, realized_pnl_pct: p.realized_pnl_pct });
      }

      let updated = 0;
      for (const sh of openShadows as Array<{ id: number; bucket: string; scanner_position_id: string; notional_usd: number }>) {
        const real = posMap.get(sh.scanner_position_id);
        if (!real) continue;
        const scaledUsd = scalePnlToBucket(real.realized_pnl_pct, sh.notional_usd);
        const { error: updErr } = await this.supabase
          .getClient()
          .from('sizing_ab_shadow_signals')
          .update({
            closed_at: real.exit_timestamp,
            closed_status: real.status,
            realized_pnl_pct: real.realized_pnl_pct,
            realized_pnl_usd: scaledUsd,
            updated_at: new Date().toISOString(),
          })
          .eq('id', sh.id);
        if (!updErr) updated++;
      }
      this.logger.log(`[sizing-ab] cronClose : ${updated} shadow signals mirror updated`);
    } catch (e) {
      this.logger.warn(`[sizing-ab] cronClose exception: ${String(e).slice(0, 200)}`);
    }
  }
}
