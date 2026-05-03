/**
 * PR6.8 RCFT — RejectedInsightsService.
 *
 * Computes FP-rate par reject_reason × env_tag depuis gainers_signal_forward.
 * Input clé pour AutoTuner Phase C V2 : "ce gate est-il trop strict (champions
 * rejetés) ou trop laxiste (failures acceptées) ?"
 *
 * Garde-fous statistiques (PR6.8 ajout 6) :
 *   - min_samples filter (défaut 20) : gates avec n<min retournent fp_rate=null
 *     (pas de division par 3 datapoints)
 *   - env_tag filter (défaut 'shadow') : pas de mélange shadow/canary/prod
 *   - since_days filter (défaut 14j) : forward window standard
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

export interface FpRateStats {
  total: number;
  champions: number;
  failures: number;
  neutral: number;
  pending_outcome: number;       // outcome IS NULL (T+72h pas atteint)
  fp_rate: number | null;        // champions / total (REJECT-side, gate trop strict)
  failure_rate: number | null;   // failures / total (ACCEPT-side, gate trop laxiste)
  avg_return_72h: number | null;
  samples_top_missed: Array<{
    symbol: string;
    return_72h: number;
    rejected_at: string;
  }>;
}

export interface RejectedInsightsQuery {
  envTag?: 'shadow' | 'canary' | 'prod';
  sinceDays?: number;
  minSamples?: number;
}

interface SignalForwardAggRow {
  symbol: string;
  asset_class: string;
  decision: string;
  reject_reason: string | null;
  outcome: string | null;
  return_72h: number | null;
  rejected_at: string;
}

@Injectable()
export class RejectedInsightsService {
  private readonly logger = new Logger(RejectedInsightsService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async getFalsePositiveRate(query: RejectedInsightsQuery = {}): Promise<{
    by_reason: Record<string, FpRateStats>;
    accept_stats: FpRateStats;
    global_fp_rate: number | null;
    global_failure_rate: number | null;
    env_tag: string;
    since_days: number;
    min_samples: number;
  }> {
    const envTag = query.envTag ?? 'shadow';
    const sinceDays = Math.min(Math.max(query.sinceDays ?? 14, 1), 90);
    const minSamples = Math.min(Math.max(query.minSamples ?? 20, 1), 1000);
    const since = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('gainers_signal_forward')
      .select('symbol, asset_class, decision, reject_reason, outcome, return_72h, rejected_at')
      .eq('env_tag', envTag)
      .gte('rejected_at', since)
      .limit(50_000);

    if (error || !data) {
      this.logger.warn(`[rcft-insights] fetch failed: ${error?.message ?? 'no data'}`);
      return {
        by_reason: {},
        accept_stats: this.emptyStats(),
        global_fp_rate: null,
        global_failure_rate: null,
        env_tag: envTag,
        since_days: sinceDays,
        min_samples: minSamples,
      };
    }

    const rows = data as SignalForwardAggRow[];

    // Bucketize par reject_reason (REJECT only)
    const buckets: Record<string, SignalForwardAggRow[]> = {};
    const acceptRows: SignalForwardAggRow[] = [];
    for (const r of rows) {
      if (r.decision === 'ACCEPT') {
        acceptRows.push(r);
      } else if (r.reject_reason) {
        if (!buckets[r.reject_reason]) buckets[r.reject_reason] = [];
        buckets[r.reject_reason].push(r);
      }
    }

    const byReason: Record<string, FpRateStats> = {};
    let globalChampions = 0;
    let globalRejectTotal = 0;

    for (const [reason, bucketRows] of Object.entries(buckets)) {
      const stats = this.computeStats(bucketRows, minSamples);
      byReason[reason] = stats;
      globalChampions += stats.champions;
      globalRejectTotal += stats.total;
    }

    const acceptStats = this.computeStats(acceptRows, minSamples);

    return {
      by_reason: byReason,
      accept_stats: acceptStats,
      global_fp_rate: globalRejectTotal >= minSamples ? globalChampions / globalRejectTotal : null,
      global_failure_rate: acceptStats.failure_rate,
      env_tag: envTag,
      since_days: sinceDays,
      min_samples: minSamples,
    };
  }

  private computeStats(rows: SignalForwardAggRow[], minSamples: number): FpRateStats {
    const stats: FpRateStats = {
      total: rows.length,
      champions: 0,
      failures: 0,
      neutral: 0,
      pending_outcome: 0,
      fp_rate: null,
      failure_rate: null,
      avg_return_72h: null,
      samples_top_missed: [],
    };

    const evaluated: SignalForwardAggRow[] = [];
    let returnSum = 0;
    let returnCount = 0;

    for (const r of rows) {
      if (r.outcome === null) {
        stats.pending_outcome++;
      } else {
        evaluated.push(r);
        if (r.outcome === 'champion') stats.champions++;
        else if (r.outcome === 'failure') stats.failures++;
        else stats.neutral++;
      }
      if (r.return_72h !== null) {
        returnSum += Number(r.return_72h);
        returnCount++;
      }
    }

    // Anti division par zéro / sample insuffisant
    if (evaluated.length >= minSamples) {
      stats.fp_rate = stats.champions / evaluated.length;
      stats.failure_rate = stats.failures / evaluated.length;
    }
    if (returnCount > 0) {
      stats.avg_return_72h = returnSum / returnCount;
    }

    // Top 5 champions/failures missed (pour debug humain)
    const interesting = rows
      .filter((r) => r.outcome === 'champion' || r.outcome === 'failure')
      .sort((a, b) => Math.abs(Number(b.return_72h ?? 0)) - Math.abs(Number(a.return_72h ?? 0)))
      .slice(0, 5);
    stats.samples_top_missed = interesting.map((r) => ({
      symbol: r.symbol,
      return_72h: Number(r.return_72h ?? 0),
      rejected_at: r.rejected_at,
    }));

    return stats;
  }

  private emptyStats(): FpRateStats {
    return {
      total: 0,
      champions: 0,
      failures: 0,
      neutral: 0,
      pending_outcome: 0,
      fp_rate: null,
      failure_rate: null,
      avg_return_72h: null,
      samples_top_missed: [],
    };
  }
}
