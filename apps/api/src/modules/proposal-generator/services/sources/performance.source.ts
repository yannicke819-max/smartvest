import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';
import type { RawProposal } from '../../interfaces/raw-proposal';

interface MandateGuardrail {
  stop_loss_trigger_pct: string | number;
}

// Minimum drawdown to trigger a review proposal when no mandate is active
const DEFAULT_DRAWDOWN_THRESHOLD_PCT = 10;
const BENCHMARK_UNDERPERFORMANCE_THRESHOLD_PCT = 5;

@Injectable()
export class PerformanceSource {
  constructor(private readonly supabase: SupabaseService) {}

  async detect(
    portfolioId: string,
    _userId: string,
    mandate: MandateGuardrail | null,
  ): Promise<RawProposal[]> {
    const proposals: RawProposal[] = [];

    const stopLossPct = mandate
      ? parseFloat(String(mandate.stop_loss_trigger_pct))
      : DEFAULT_DRAWDOWN_THRESHOLD_PCT;

    // Get last 30 snapshots to compute max value and current drawdown
    const { data: snapshots } = await this.supabase.getClient()
      .from('portfolio_history_snapshots')
      .select('as_of_date, total_market_value, pnl_percent')
      .eq('portfolio_id', portfolioId)
      .order('as_of_date', { ascending: false })
      .limit(30);

    if (!snapshots?.length) return [];

    const rows = snapshots as Array<{ as_of_date: string; total_market_value: string; pnl_percent: string }>;
    const latestValue = parseFloat(rows[0]!.total_market_value);
    const peakValue = Math.max(...rows.map((r) => parseFloat(r.total_market_value)));
    const drawdownPct = peakValue > 0 ? ((peakValue - latestValue) / peakValue) * 100 : 0;

    if (drawdownPct >= stopLossPct) {
      proposals.push({
        action: 'other',
        currency: 'EUR',
        rationale: `Drawdown significatif détecté : -${drawdownPct.toFixed(1)}%${mandate ? ` (seuil stop-loss mandat : ${stopLossPct}%)` : ''}. Une revue de l'allocation est recommandée.`,
        assumptions: [
          `Valeur pic sur 30 jours : ${peakValue.toFixed(2)} EUR`,
          `Valeur actuelle : ${latestValue.toFixed(2)} EUR`,
          `Drawdown calculé : -${drawdownPct.toFixed(2)}%`,
          'Fenêtre de calcul : 30 derniers snapshots journaliers',
        ],
        sourceKind: 'drawdown',
        score: drawdownPct >= stopLossPct * 1.5 ? 0.90 : 0.70,
        expiresInDays: 3,
        dedupKey: `drawdown:${portfolioId}`,
      });
    } else if (drawdownPct >= stopLossPct * 0.5) {
      // Pre-alert: drawdown approaching threshold
      proposals.push({
        action: 'other',
        currency: 'EUR',
        rationale: `Drawdown en progression : -${drawdownPct.toFixed(1)}% (seuil à surveiller : ${stopLossPct}%). Une revue préventive est suggérée.`,
        assumptions: [
          `Drawdown actuel : -${drawdownPct.toFixed(2)}%`,
          `Seuil d'alerte : ${stopLossPct}%`,
        ],
        sourceKind: 'drawdown',
        score: 0.55,
        expiresInDays: 5,
        dedupKey: `drawdown_prealert:${portfolioId}`,
      });
    }

    // Benchmark underperformance check — use pnl_percent of latest snapshot vs a naive 0% benchmark
    const latestPnlPct = parseFloat(rows[0]!.pnl_percent);
    if (latestPnlPct < -BENCHMARK_UNDERPERFORMANCE_THRESHOLD_PCT) {
      proposals.push({
        action: 'other',
        currency: 'EUR',
        rationale: `Performance négative persistante : ${latestPnlPct.toFixed(1)}% vs coût d'acquisition. Une revue de la stratégie d'allocation est suggérée.`,
        assumptions: [
          `P&L cumulé : ${latestPnlPct.toFixed(2)}%`,
          `Seuil de déclenchement : -${BENCHMARK_UNDERPERFORMANCE_THRESHOLD_PCT}%`,
          'Les performances passées ne préjugent pas des performances futures.',
        ],
        sourceKind: 'benchmark',
        score: 0.50,
        expiresInDays: 14,
        dedupKey: `benchmark:${portfolioId}`,
      });
    }

    return proposals;
  }
}
