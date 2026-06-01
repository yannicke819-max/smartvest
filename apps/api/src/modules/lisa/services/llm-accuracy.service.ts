/**
 * LlmAccuracyService — boucle de feedback "qui a raison ?" sur les shadows LLM.
 *
 * Phase 1 : risk_monitor. Pour chaque position fermée, backfill les rows
 * llm_ab_shadow_decisions correspondantes (target_id=position.id) avec :
 *   - outcome_pnl_pct : PnL réel %
 *   - outcome_label   : win / loss / breakeven
 *
 * Ensuite computeAccuracy() agrège par provider : Brier score + Pearson
 * correlation entre verdict_score et outcome_pnl_pct.
 *
 * Endpoint : GET /admin/llm-accuracy?call_site=risk_monitor&days=14
 *
 * Phase 2 (PR follow-up) : étendre aux 3 autres call sites.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  brierScore,
  pearsonCorrelation,
  directionalAccuracy,
  parseRiskVerdictScore,
} from './llm-accuracy.helper';

interface ShadowEntry {
  provider: string;
  response_summary: string | null;
}

interface ShadowRow {
  id: string;
  applied_provider: string;
  applied_response_summary: string | null;
  shadows: ShadowEntry[] | null;
  outcome_pnl_pct: number | null;
  outcome_label: string | null;
}

export interface ProviderAccuracy {
  provider: string;
  n: number;
  brier: number | null;
  correlation: number | null;
  directional_accuracy: number | null;
  avg_score: number | null;
  avg_outcome_pct: number | null;
}

export interface CallSiteAccuracy {
  call_site: string;
  window_days: number;
  total_samples: number;
  resolved_samples: number;
  by_provider: ProviderAccuracy[];
  verdict: string;
}

@Injectable()
export class LlmAccuracyService {
  private readonly logger = new Logger(LlmAccuracyService.name);

  constructor(@Optional() private readonly supabase?: SupabaseService) {}

  /**
   * Appelé par MechanicalTradingService.closePosition après le close DB.
   * Backfill toutes les shadow rows risk_monitor associées à cette position.
   *
   * @param positionId  lisa_positions.id
   * @param pnlPct      PnL réalisé en % (positif = win, négatif = loss)
   */
  async linkPositionOutcome(positionId: string, pnlPct: number): Promise<void> {
    if (!this.supabase?.isReady()) return;
    const label = pnlPct > 0.05 ? 'win' : pnlPct < -0.05 ? 'loss' : 'breakeven';
    try {
      const { error } = await this.supabase
        .getClient()
        .from('llm_ab_shadow_decisions')
        .update({
          outcome_pnl_pct: pnlPct,
          outcome_label: label,
          outcome_resolved_at: new Date().toISOString(),
        })
        .eq('target_id', positionId)
        .is('outcome_resolved_at', null);
      if (error) {
        this.logger.debug(`[llm-accuracy] backfill ${positionId.slice(0, 8)} failed: ${error.message}`);
      }
    } catch (e) {
      this.logger.debug(`[llm-accuracy] backfill ${positionId.slice(0, 8)} exception: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Compute accuracy metrics par provider pour un call_site donné sur les
   * N derniers jours. Ne prend que les rows avec outcome_resolved_at set.
   */
  async computeAccuracy(callSite: string, days: number): Promise<CallSiteAccuracy> {
    if (!this.supabase?.isReady()) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: 0,
        resolved_samples: 0,
        by_provider: [],
        verdict: 'supabase not ready',
      };
    }

    const since = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    const { data: rows, error } = await this.supabase
      .getClient()
      .from('llm_ab_shadow_decisions')
      .select('id, applied_provider, applied_response_summary, shadows, outcome_pnl_pct, outcome_label')
      .eq('call_site', callSite)
      .gte('created_at', since);
    if (error || !rows) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: 0,
        resolved_samples: 0,
        by_provider: [],
        verdict: `query failed: ${error?.message ?? 'unknown'}`,
      };
    }

    const totalSamples = rows.length;
    const resolved = rows.filter((r: ShadowRow) => r.outcome_pnl_pct !== null);
    if (resolved.length === 0) {
      return {
        call_site: callSite,
        window_days: days,
        total_samples: totalSamples,
        resolved_samples: 0,
        by_provider: [],
        verdict: `no resolved outcomes yet (need positions to close)`,
      };
    }

    // Phase 1 : risk_monitor only — extract score via parseRiskVerdictScore.
    // (Phase 2 : autres call sites auront leur propre extracteur.)
    const extractScore = callSite === 'risk_monitor' ? parseRiskVerdictScore : () => null;

    // Aggregate per provider
    const byProvider = new Map<string, { scores: number[]; outcomesPct: number[]; outcomesBin: number[] }>();
    const ensure = (p: string) => {
      if (!byProvider.has(p)) byProvider.set(p, { scores: [], outcomesPct: [], outcomesBin: [] });
      return byProvider.get(p)!;
    };

    for (const r of resolved as ShadowRow[]) {
      const outcomePct = Number(r.outcome_pnl_pct);
      const outcomeBin = outcomePct > 0 ? 1 : 0;

      // Applied provider
      const appliedScore = extractScore(r.applied_response_summary);
      if (appliedScore !== null) {
        const b = ensure(r.applied_provider);
        b.scores.push(appliedScore);
        b.outcomesPct.push(outcomePct);
        b.outcomesBin.push(outcomeBin);
      }

      // Shadow providers
      for (const s of r.shadows ?? []) {
        const sScore = extractScore(s.response_summary);
        if (sScore !== null) {
          const b = ensure(s.provider);
          b.scores.push(sScore);
          b.outcomesPct.push(outcomePct);
          b.outcomesBin.push(outcomeBin);
        }
      }
    }

    const byProviderArr: ProviderAccuracy[] = [];
    for (const [provider, b] of byProvider.entries()) {
      byProviderArr.push({
        provider,
        n: b.scores.length,
        brier: brierScore(b.scores, b.outcomesBin),
        correlation: pearsonCorrelation(b.scores, b.outcomesPct),
        directional_accuracy: directionalAccuracy(b.scores, b.outcomesPct),
        avg_score: b.scores.length > 0 ? b.scores.reduce((s, v) => s + v, 0) / b.scores.length : null,
        avg_outcome_pct:
          b.outcomesPct.length > 0 ? b.outcomesPct.reduce((s, v) => s + v, 0) / b.outcomesPct.length : null,
      });
    }

    // Sort by Brier (lower = better)
    byProviderArr.sort((a, b) => (a.brier ?? Infinity) - (b.brier ?? Infinity));
    const best = byProviderArr[0];
    const verdict =
      best && best.brier !== null
        ? `${best.provider} is best on ${callSite} (Brier=${best.brier.toFixed(3)}, n=${best.n}/${resolved.length} samples ${days}d)`
        : `insufficient resolved samples for ranking (n=${resolved.length})`;

    return {
      call_site: callSite,
      window_days: days,
      total_samples: totalSamples,
      resolved_samples: resolved.length,
      by_provider: byProviderArr,
      verdict,
    };
  }
}
