import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#4 — Régime asia : volatilité 24h glissante.
 *
 * Data 7j : tercile vol moyen (1.4-2.0) = +$76/j seul profitable.
 * Bas (<1.4) et haut (>2.0) = pertes systématiques.
 *
 * Stratégie :
 *   - Query gainers_user_shadow_signals.change_pct_1m sur 24h pour asset_class='asia_equity'
 *   - Compute stddev → si hors [QW4_REGIME_VOL_LOWER, QW4_REGIME_VOL_UPPER] : block
 *   - Cache 5 min (mémoire) pour éviter de hammer Supabase à chaque ouverture
 *
 * Si la query échoue ou retourne < 5 lignes : pass (fail-open, données insuffisantes).
 */
@Injectable()
export class Qw4RegimeFilterService {
  private readonly logger = new Logger(Qw4RegimeFilterService.name);
  private readonly lower: number;
  private readonly upper: number;
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private cachedStddev: number | null = null;
  private cachedAt: number = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    this.lower = Number.parseFloat(this.config.get<string>('QW4_REGIME_VOL_LOWER') ?? '1.4');
    this.upper = Number.parseFloat(this.config.get<string>('QW4_REGIME_VOL_UPPER') ?? '2.0');
  }

  async check(signal: QwSignal): Promise<QwTrace> {
    if (signal.assetClass !== 'asia_equity') {
      return { qwId: 'QW_4', decision: 'pass', reason: 'not_asia_class' };
    }

    const stddev = await this.getAsiaVol24h();
    if (stddev === null) {
      return { qwId: 'QW_4', decision: 'pass', reason: 'regime_data_insufficient' };
    }

    if (stddev >= this.lower && stddev <= this.upper) {
      return { qwId: 'QW_4', decision: 'pass', reason: `regime_in_range_${stddev.toFixed(3)}` };
    }

    this.decisionLogger.log({
      qwId: 'QW_4',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'regime_extreme_vol',
      wouldHavePassedWithoutFlag: true,
      details: { stddev, lower: this.lower, upper: this.upper },
    });
    return { qwId: 'QW_4', decision: 'block', reason: 'regime_extreme_vol' };
  }

  /** Visible pour tests + caching. Retourne null si données < 5 ou erreur. */
  async getAsiaVol24h(): Promise<number | null> {
    if (this.cachedStddev !== null && Date.now() - this.cachedAt < this.cacheTtlMs) {
      return this.cachedStddev;
    }
    if (this.inflight) {
      await this.inflight;
      return this.cachedStddev;
    }
    this.inflight = this.refreshVol();
    await this.inflight;
    this.inflight = null;
    return this.cachedStddev;
  }

  private async refreshVol(): Promise<void> {
    if (!this.supabase.isReady()) return;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await this.supabase
        .getClient()
        .from('gainers_user_shadow_signals')
        .select('change_pct_1m')
        .eq('asset_class', 'asia_equity')
        .gte('created_at', since)
        .limit(2000);
      if (error) {
        this.logger.warn(`QW_4 asia vol query failed: ${error.message}`);
        return;
      }
      const values = (data ?? [])
        .map((r: { change_pct_1m: number | null }) => Number(r.change_pct_1m))
        .filter((n) => Number.isFinite(n));
      if (values.length < 5) {
        this.cachedStddev = null;
        this.cachedAt = Date.now();
        return;
      }
      this.cachedStddev = stddev(values);
      this.cachedAt = Date.now();
    } catch (err) {
      this.logger.warn(`QW_4 asia vol exception: ${(err as Error).message}`);
    }
  }
}

function stddev(xs: number[]): number {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}
