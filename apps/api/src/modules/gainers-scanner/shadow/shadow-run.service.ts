/**
 * ADR-005 Step 9 — Shadow run orchestrator.
 *
 * En mode shadow (flag GAINERS_V1_SHADOW=true) :
 *   - Le pipeline BLOC 1→2→3→4 tourne normalement sur les candidats
 *   - Aucune position réelle n'est ouverte (gainers_positions inchangé)
 *   - Chaque signal (ACCEPT et REJECT) est persisté dans gainers_v1_shadow_signals
 *   - Worker exit-simulator (post-hoc) calcule simulated_pnl_pct par replay
 *
 * Cette première version (PR6 init) livre :
 *   - persistShadowSignal(candidate) : insère dans gainers_v1_shadow_signals
 *   - getShadowMetrics(): aggrège win-rate / divergence / power test
 *
 * Les workers exit-simulator + cron schedule = follow-up dans PR6.2.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import type { GainersScoredCandidate } from '../domain/gainers-candidate.types';
import { proportionTest, requiredSampleSize, ProportionTestResult } from './power-analysis';

export interface ShadowMetricsResult {
  totalSignals: number;
  acceptCount: number;
  rejectCount: number;
  closedWithPnl: number;
  wins: number;
  losses: number;
  divergenceCount: number;
  divergencePct: number;
  proportionTest: ProportionTestResult;
  meetsBasculeCriteria: boolean;
  basculeChecklist: {
    minSignals30: boolean;
    minSessions20: boolean;
    winRate45: boolean;
    divergence20: boolean;
  };
}

@Injectable()
export class GainersShadowRunService {
  private readonly logger = new Logger(GainersShadowRunService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  /** True si le flag d'env GAINERS_V1_SHADOW est activé. */
  isShadowEnabled(): boolean {
    return this.config.get<string>('GAINERS_V1_SHADOW') === 'true';
  }

  /**
   * Persiste un signal V1 (ACCEPT ou REJECT) dans la table shadow.
   * Idempotent côté DB (pas d'unique constraint sur ce flux append-only).
   *
   * PR6.5 — enrichi avec entry_path_eff + tp_price + sl_price calculés via
   * BLOC 4 §11.1 pour permettre le worker exit-simulator de replay la state
   * machine.
   * PR6.6 — accepte pathEffOverride (P9-UX réel) ; default 0.5% si absent.
   */
  async persistShadowSignal(
    candidate: GainersScoredCandidate,
    legacyDecision: 'ACCEPT' | 'REJECT' | null = null,
    pathEffOverride: number | null = null,
  ): Promise<void> {
    if (!this.isShadowEnabled()) return;

    const { raw, decision, rejectReason, compositeScore, entrySignal, bloc3Diagnostics } = candidate;

    // BLOC 4 §11.1 : equity TP=×1.5/SL=×1.0, crypto TP=×2.0/SL=×0.8
    // PR6.6 : pathEffOverride (mtfPersistence.pathQuality) si dispo, else 0.5%
    // pathEff est un % (0.5 = 0.5% mouvement attendu)
    const pathEffRaw = pathEffOverride !== null && pathEffOverride > 0
      ? Math.min(pathEffOverride * 100, 5) // overallEfficiency [0,1] → cap 5% mvt
      : 0.5;
    const tpMul = raw.market === 'crypto' ? 2.0 : 1.5;
    const slMul = raw.market === 'crypto' ? 0.8 : 1.0;
    const tpPct = (pathEffRaw * tpMul) / 100;
    const slPct = (pathEffRaw * slMul) / 100;
    const entryPrice = entrySignal ? raw.close : (decision === 'ACCEPT' ? raw.close : null);
    const tpPrice = entryPrice !== null ? entryPrice * (1 + tpPct) : null;
    const slPrice = entryPrice !== null ? entryPrice * (1 - slPct) : null;

    const payload: Record<string, unknown> = {
      symbol: raw.symbol,
      exchange: raw.exchange,
      asset_class: raw.market,
      setup_type: entrySignal?.triggerKind ?? null,
      composite_score: compositeScore,
      decision,
      reject_reason: rejectReason,
      entry_price: entryPrice,
      entry_path_eff: entryPrice !== null ? pathEffRaw : null,
      tp_price: tpPrice,
      sl_price: slPrice,
      fibo_level: entrySignal?.fiboLevel ?? null,
      spread_proxy: bloc3Diagnostics?.spreadProxy ?? null,
      volume_ratio: bloc3Diagnostics?.volumeRatio ?? null,
      session: bloc3Diagnostics?.session ?? null,
      legacy_decision: legacyDecision,
    };

    const { error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .insert(payload);

    if (error) {
      this.logger.warn(`[shadow-run] insert failed for ${raw.symbol}: ${error.message}`);
    }
  }

  /**
   * Aggrège les métriques shadow + power test + critères bascule.
   * Lecture-seule, idempotent.
   */
  async getShadowMetrics(sinceDays = 30): Promise<ShadowMetricsResult> {
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();
    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_v1_shadow_signals')
      .select('decision, simulated_pnl_pct, diverges_from_legacy, created_at')
      .gte('created_at', since);

    if (error || !data) {
      this.logger.warn(`[shadow-run] metrics query failed: ${error?.message ?? 'no data'}`);
      return this.emptyMetrics();
    }

    let acceptCount = 0;
    let rejectCount = 0;
    let closedWithPnl = 0;
    let wins = 0;
    let losses = 0;
    let divergenceCount = 0;
    const sessionDates = new Set<string>();

    for (const row of data) {
      const r = row as any;
      if (r.decision === 'ACCEPT') acceptCount++;
      else rejectCount++;
      if (r.simulated_pnl_pct !== null) {
        const pnl = Number(r.simulated_pnl_pct);
        closedWithPnl++;
        if (pnl > 0) wins++;
        else if (pnl < 0) losses++;
      }
      if (r.diverges_from_legacy === true) divergenceCount++;
      sessionDates.add((r.created_at as string).slice(0, 10));
    }

    const totalSignals = data.length;
    const sessionsCount = sessionDates.size;
    const divergencePct = totalSignals > 0 ? divergenceCount / totalSignals : 0;
    const test = proportionTest({ n: closedWithPnl, wins });

    const checklist = {
      minSignals30: acceptCount >= 30,
      minSessions20: sessionsCount >= 20,
      winRate45: closedWithPnl > 0 && wins / closedWithPnl >= 0.45,
      divergence20: divergencePct <= 0.20,
    };

    return {
      totalSignals,
      acceptCount,
      rejectCount,
      closedWithPnl,
      wins,
      losses,
      divergenceCount,
      divergencePct,
      proportionTest: test,
      meetsBasculeCriteria: checklist.minSignals30 && checklist.minSessions20 && checklist.winRate45 && checklist.divergence20,
      basculeChecklist: checklist,
    };
  }

  /** Required sample size pour atteindre power=0.90 sur effect delta donné. */
  computeRequiredSampleSize(effectDelta: number): number {
    return requiredSampleSize(effectDelta);
  }

  private emptyMetrics(): ShadowMetricsResult {
    return {
      totalSignals: 0, acceptCount: 0, rejectCount: 0,
      closedWithPnl: 0, wins: 0, losses: 0,
      divergenceCount: 0, divergencePct: 0,
      proportionTest: {
        winRate: 0, zStat: 0, pValue: 1,
        ci95Wilson: [0, 0], recommendation: 'INSUFFICIENT_SAMPLES',
      },
      meetsBasculeCriteria: false,
      basculeChecklist: {
        minSignals30: false, minSessions20: false,
        winRate45: false, divergence20: false,
      },
    };
  }
}
