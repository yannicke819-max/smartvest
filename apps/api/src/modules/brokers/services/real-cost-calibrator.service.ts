import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';

/**
 * Phase F — RealCostCalibratorService.
 *
 * Compare le coût THÉORIQUE (cost-engine) au coût RÉEL (broker fills) sur
 * les 30 derniers jours. Si écart moyen > 10% → log alert + propose
 * recalibration des coefficients cost-engine (manuel pour l'instant, V2
 * automatique).
 *
 * Cron : daily 03:00 UTC. Skip si moins de 30 trades LIVE fermés.
 *
 * Métriques produites :
 *   - avg_theoretical_fees_per_trade
 *   - avg_actual_fees_per_trade
 *   - delta_pct = (actual − theoretical) / theoretical × 100
 *   - by_venue : breakdown par exchange (US/EU/Asia/Crypto)
 *   - by_asset_class
 *
 * Alerts :
 *   - delta_pct > 10% → log warning + INSERT decision_log kind='cost_calibration_drift'
 *   - delta_pct > 25% → log error + recommendation forte
 *
 * Activation : tourne tant qu'il y a des trades LIVE (broker_order_id_entry
 * NOT NULL). Pas de feature flag — c'est purement analytique, no side-effect.
 */

interface CalibrationMetric {
  asset_class: string;
  venue: string;
  count: number;
  avg_theoretical_fees: number;
  avg_actual_fees: number;
  avg_theoretical_slippage_bps: number;
  avg_actual_slippage_bps: number;
  delta_fees_pct: number;
  delta_slippage_pct: number;
}

@Injectable()
export class RealCostCalibratorService {
  private readonly logger = new Logger(RealCostCalibratorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /** Cron daily à 03:00 UTC. */
  @Cron('0 0 3 * * *', { name: 'real-cost-calibration' })
  async runCalibrationCron(): Promise<void> {
    try {
      await this.runCalibrationInner();
    } catch (e) {
      this.logger.error(`[cost-calibration] failed: ${String(e).slice(0, 200)}`);
    }
  }

  private async runCalibrationInner(): Promise<void> {
    void this.flags; // for future feature-flag wiring

    // Trades LIVE fermés sur 30 derniers jours (broker_order_id_entry présent)
    const sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const { data: rows } = await this.supabase
      .getClient()
      .from('lisa_positions')
      .select('asset_class, venue, entry_notional_usd, estimated_entry_cost_usd, actual_entry_fees_usd, actual_exit_fees_usd, actual_entry_slippage_bps, actual_exit_slippage_bps')
      .not('broker_order_id_entry', 'is', null)
      .neq('status', 'open')
      .gte('exit_timestamp', sinceIso);

    if (!rows || rows.length < 30) {
      this.logger.debug(
        `[cost-calibration] only ${rows?.length ?? 0} LIVE trades < 30 — skip (need more data)`,
      );
      return;
    }

    // Agrégation par (asset_class × venue)
    const groups = new Map<string, {
      asset_class: string;
      venue: string;
      count: number;
      sum_theoretical: number;
      sum_actual: number;
      sum_actual_slip: number;
    }>();

    for (const r of rows) {
      const key = `${r.asset_class}::${r.venue}`;
      const cur = groups.get(key) ?? {
        asset_class: r.asset_class,
        venue: r.venue,
        count: 0,
        sum_theoretical: 0,
        sum_actual: 0,
        sum_actual_slip: 0,
      };
      cur.count += 1;
      cur.sum_theoretical += parseFloat(String(r.estimated_entry_cost_usd ?? 0));
      cur.sum_actual += parseFloat(String(r.actual_entry_fees_usd ?? 0))
        + parseFloat(String(r.actual_exit_fees_usd ?? 0));
      cur.sum_actual_slip += Math.abs(Number(r.actual_entry_slippage_bps ?? 0))
        + Math.abs(Number(r.actual_exit_slippage_bps ?? 0));
      groups.set(key, cur);
    }

    const metrics: CalibrationMetric[] = [];
    let alertsCount = 0;
    for (const g of groups.values()) {
      if (g.count < 5) continue; // pas assez de samples
      const avg_t = g.sum_theoretical / g.count;
      const avg_a = g.sum_actual / g.count;
      const delta_pct = avg_t > 0 ? ((avg_a - avg_t) / avg_t) * 100 : 0;

      const m: CalibrationMetric = {
        asset_class: g.asset_class,
        venue: g.venue,
        count: g.count,
        avg_theoretical_fees: round2(avg_t),
        avg_actual_fees: round2(avg_a),
        avg_theoretical_slippage_bps: 5, // hardcoded baseline (cost-engine assumes 5bps)
        avg_actual_slippage_bps: round2(g.sum_actual_slip / g.count),
        delta_fees_pct: round2(delta_pct),
        delta_slippage_pct: round2(((g.sum_actual_slip / g.count) - 5) / 5 * 100),
      };
      metrics.push(m);

      if (Math.abs(delta_pct) > 10) {
        alertsCount += 1;
        const severity = Math.abs(delta_pct) > 25 ? 'error' : 'warn';
        this.logger.log(
          `[cost-calibration] ${severity.toUpperCase()} ${m.asset_class}/${m.venue} : ` +
          `theoretical=$${m.avg_theoretical_fees} actual=$${m.avg_actual_fees} ` +
          `(${delta_pct > 0 ? '+' : ''}${delta_pct.toFixed(1)}%, ${m.count} trades)`,
        );
      }
    }

    // Persist le report dans decision_log (un par jour)
    if (metrics.length > 0) {
      await this.supabase
        .getClient()
        .from('lisa_decision_log')
        .insert({
          kind: alertsCount > 0 ? 'cost_calibration_drift' : 'cost_calibration_ok',
          summary: `[COST_CALIBRATION] ${rows.length} LIVE trades / 30j — ${alertsCount} alert(s) sur ${metrics.length} groupes`,
          rationale: alertsCount > 0
            ? 'Écart théorique vs actual > 10% détecté sur certains groupes asset_class/venue. Recalibration cost-engine recommandée.'
            : 'Théorique vs actual aligné < 10% sur tous les groupes.',
          payload: { metrics, total_trades: rows.length, alerts_count: alertsCount },
          triggered_by: 'real_cost_calibrator_cron',
        })
        .then(() => undefined, () => undefined);
    }

    this.logger.log(
      `[cost-calibration] processed ${rows.length} LIVE trades, ${metrics.length} groups, ${alertsCount} alert(s)`,
    );
  }
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
