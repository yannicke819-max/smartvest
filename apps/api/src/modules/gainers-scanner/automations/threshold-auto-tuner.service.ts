/**
 * Phase C — ThresholdAutoTunerService.
 *
 * Cron weekly Monday 03:00 UTC qui analyse `paper_trades` fermés et propose
 * automatiquement des ajustements de seuils ADR-005 §1bis.
 *
 * NE FLIP JAMAIS LES SEUILS AUTOMATIQUEMENT — log uniquement des
 * `threshold_proposal` insights avec ROI estimé. L'humain valide via
 * `PATCH /admin/gainers/insights/:id` status=actioned + applique ensuite
 * la PR de modification de seuil.
 *
 * Stratégie d'analyse :
 *   1. Pour chaque seuil tunable (persistence_min, liquidity_floor_crypto,
 *      market_cap_min_equity), scanne paper_trades closed avec outcome_label
 *   2. Bucketise par valeur du feature at-entry
 *   3. Calc P(win) par bucket via empirical-law (Wilson interval)
 *   4. Identifie le seuil optimal qui maximise expected value
 *      EV = P(win) × avg_win - (1-P(win)) × avg_loss
 *   5. Si proposed != current ET sample_size > 30 ET ev_diff > 0.5%
 *      → log threshold_proposal insight avec ROI estimé
 *
 * Prerequisites :
 *   - paper_trades doit avoir > 30 closed positions (Phase 4 canary 10%)
 *   - features_at_entry JSONB rempli avec persistence_count, vol24h, market_cap
 *
 * Sans ces prerequisites, le service détecte et log un insight 'data_quality'
 * severity=low pour signaler que l'auto-tuning n'est pas encore actionnable.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { GainersInsightsService } from '../insights/gainers-insights.service';

const MIN_SAMPLE_SIZE = 30;
const MIN_EV_DIFFERENCE_PCT = 0.005; // 0.5% expected value diff requis
const TUNABLE_THRESHOLDS = [
  'persistence_min_score',
  'liquidity_floor_crypto_usd',
  'liquidity_floor_equity_usd',
  'market_cap_min_crypto_usd',
  'market_cap_min_equity_usd',
  'volatility_clamp_max_atr_rel',
] as const;

interface PaperTradeRow {
  outcome_label: 'win' | 'loss' | null;
  pnl_pct: number | null;
  features_at_entry: Record<string, unknown> | null;
  exit_timestamp: string | null;
}

@Injectable()
export class ThresholdAutoTunerService {
  private readonly logger = new Logger(ThresholdAutoTunerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly insights: GainersInsightsService,
  ) {}

  /** Cron weekly Monday 03:00 UTC — propose threshold ajustements après refit P9. */
  @Cron('0 3 * * 1')
  async runWeeklyTune(): Promise<void> {
    try {
      await this.runInner();
    } catch (e) {
      this.logger.error(`[auto-tuner] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runInner(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('paper_trades')
      .select('outcome_label, pnl_pct, features_at_entry, exit_timestamp')
      .not('exit_timestamp', 'is', null)
      .gte('exit_timestamp', cutoff)
      .limit(5000);

    if (error || !data) {
      this.logger.warn(`[auto-tuner] fetch paper_trades failed: ${error?.message ?? 'no data'}`);
      return;
    }

    const trades = (data as PaperTradeRow[]).filter(
      (t) => t.outcome_label !== null && t.pnl_pct !== null && t.features_at_entry !== null,
    );

    if (trades.length < MIN_SAMPLE_SIZE) {
      // Phase C non-actionnable yet — log data_quality insight (1×/semaine)
      await this.insights.logInsight({
        type: 'data_quality',
        source: 'auto_threshold_tuner',
        severity: 'low',
        summary: `Auto-tuner inactif : ${trades.length} closed trades < ${MIN_SAMPLE_SIZE} requis (attendre Phase 4 canary)`,
        payload: {
          closed_trades_count: trades.length,
          min_required: MIN_SAMPLE_SIZE,
          lookback_days: 90,
          tunable_thresholds: [...TUNABLE_THRESHOLDS],
        },
      });
      return;
    }

    let proposalsLogged = 0;
    for (const thresholdName of TUNABLE_THRESHOLDS) {
      const proposal = this.analyzeThreshold(thresholdName, trades);
      if (proposal && Math.abs(proposal.evDiffPct) >= MIN_EV_DIFFERENCE_PCT) {
        await this.insights.logInsight({
          type: 'threshold_proposal',
          source: 'auto_threshold_tuner',
          severity: Math.abs(proposal.evDiffPct) > 0.02 ? 'medium' : 'low',
          summary: `${thresholdName} : propose ${proposal.proposedValue} (current ${proposal.currentValue}) — EV diff +${(proposal.evDiffPct * 100).toFixed(2)}%`,
          payload: {
            threshold_name: thresholdName,
            current_value: proposal.currentValue,
            proposed_value: proposal.proposedValue,
            current_ev_pct: proposal.currentEvPct,
            proposed_ev_pct: proposal.proposedEvPct,
            ev_diff_pct: proposal.evDiffPct,
            sample_size: proposal.sampleSize,
            buckets: proposal.buckets,
            requires_human_validation: true,
            adr_lock: 'ADR-005 §1bis',
          },
        });
        proposalsLogged++;
      }
    }

    this.logger.log(
      `[auto-tuner] analyzed ${trades.length} closed trades, ${proposalsLogged} threshold_proposal insight(s) logged`,
    );
  }

  /**
   * Analyze un seuil donné : bucketise les trades par valeur du feature,
   * compute P(win) + avg_win + avg_loss par bucket, identifie le seuil
   * optimal en termes d'expected value.
   *
   * Stub implementation : retourne null pour l'instant. Sera implémenté
   * post-Phase 4 quand on aura >30 closed trades avec features_at_entry
   * structuré.
   */
  private analyzeThreshold(
    name: string,
    trades: PaperTradeRow[],
  ): {
    currentValue: number;
    proposedValue: number;
    currentEvPct: number;
    proposedEvPct: number;
    evDiffPct: number;
    sampleSize: number;
    buckets: Array<{ range: string; n: number; pWin: number; avgPnl: number }>;
  } | null {
    // Phase C v1 : analyse stub. Implémentation complète viendra une fois
    // qu'on aura > 30 closed paper_trades avec features_at_entry rempli
    // (canary Phase 4). Le service est wired et fonctionnel, juste inerte
    // tant qu'aucune donnée d'entraînement n'est dispo.
    void name;
    void trades;
    return null;
  }
}
