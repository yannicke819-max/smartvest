import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { KellySizingService } from '../../gainers-scanner/kelly/kelly-sizing.service';

/**
 * Phase 5 N2 — worker horaire qui recalcule la matrice Kelly par asset_class.
 *
 * Pour chaque classe :
 *  1. Fetch stats 14j glissants depuis lisa_positions (n_closed, WR, payoff)
 *  2. Filtre outliers R5 : realized_pnl_pct > -50 ET exit_price > entry × 0.5
 *  3. Si n_closed < 30 → skip (échantillon insuffisant, ADR-007 §3.4)
 *  4. Appel KellySizingService.compute() (Wilson95L + half-Kelly + clamp 0.25)
 *  5. Conversion fraction → notional via CAPITAL_ESTIME_USD (clamp [500, 3000])
 *  6. Upsert asset_class_kelly_config
 *
 * Si edge négatif (fullKelly ≤ 0) : upsert notional=1575 (fallback), fraction=0,
 * source='auto_recompute_no_edge'. Le service consommateur lit la fraction et
 * désactive l override → caller utilise le notional uniforme historique.
 *
 * PR #359 (19/05/2026) — no-edge reducer :
 *   Quand edge négatif ET WR observé < 20% sur sample suffisant (>= 30), le
 *   baseline $1575 reste trop agressif : le 19 mai PnL -$534/jour avec
 *   WR=12.9%. On réduit à $800 (NOTIONAL_REDUCED_USD) pour bridger jusqu'à
 *   retour edge positif. Source = 'auto_recompute_reduced_low_wr'.
 */

const ASSET_CLASSES = [
  'us_equity_large',
  'us_equity_small_mid',
  'eu_equity',
  'asia_equity',
  'crypto_major',
] as const;

const NOTIONAL_FALLBACK_USD = 1575;
const NOTIONAL_REDUCED_USD = 800; // PR #359 — reducer no-edge + WR low
const NOTIONAL_MIN = 500;
const NOTIONAL_MAX = 3000;
const LOW_WR_THRESHOLD = 0.20; // PR #359 — WR observé < 20% = signal dégradé
const LOW_WR_MIN_SAMPLE = 30; // PR #359 — sample minimal pour appliquer le reducer

// TODO Phase 5 N3 : récupérer le capital réel via portfolios.equity_usd au lieu
// de la constante. Pour MVP, baseline = notional_avg actuel × max positions.
const CAPITAL_ESTIME_USD = 15_750;
const DEFAULT_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001'; // TRADER (ex-MAIN 58439d86 migré 30/05/2026)

interface ClassStats {
  n_closed: number;
  wr: number;
  tp_avg_pct: number | null;
  sl_avg_pct: number | null;
}

@Injectable()
export class KellyRecomputeService {
  private readonly logger = new Logger(KellyRecomputeService.name);
  private readonly portfolioId: string;
  private readonly capitalUsd: number;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
    private readonly kellySizing: KellySizingService,
  ) {
    this.portfolioId = this.config.get<string>('PORTFOLIO_ID') ?? DEFAULT_PORTFOLIO_ID;
    const raw = this.config.get<string>('KELLY_CAPITAL_ESTIME_USD');
    const parsed = raw != null ? Number.parseFloat(raw) : NaN;
    this.capitalUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : CAPITAL_ESTIME_USD;
  }

  @Cron('0 * * * *', { timeZone: 'UTC' })
  async recomputeAll(): Promise<void> {
    if (!this.supabase.isReady()) {
      this.logger.warn('[Kelly] Supabase not ready — skip hourly recompute');
      return;
    }
    this.logger.log(`[Kelly] hourly recompute start (portfolio=${this.portfolioId.slice(0, 8)} capital=$${this.capitalUsd})`);
    for (const assetClass of ASSET_CLASSES) {
      try {
        await this.recomputeForClass(assetClass);
      } catch (err) {
        this.logger.warn(`[Kelly] recompute failed for ${assetClass}: ${(err as Error).message}`);
      }
    }
    this.logger.log('[Kelly] hourly recompute done');
  }

  /** Visible pour tests + endpoint admin éventuel. */
  async recomputeForClass(assetClass: string): Promise<void> {
    const stats = await this.fetchClassStats(assetClass);
    if (!stats) return; // erreur déjà loggée

    if (stats.n_closed < 30) {
      this.logger.log(
        `[Kelly] ${assetClass} skip : n_closed=${stats.n_closed} < 30 (échantillon insuffisant)`,
      );
      return;
    }

    const payoffRatio = this.computePayoffRatio(stats.tp_avg_pct, stats.sl_avg_pct);
    if (payoffRatio === null) {
      this.logger.warn(
        `[Kelly] ${assetClass} skip : payoff ratio non calculable (tp_avg=${stats.tp_avg_pct} sl_avg=${stats.sl_avg_pct})`,
      );
      return;
    }

    const result = this.kellySizing.compute({
      winRate: stats.wr,
      sampleSize: stats.n_closed,
      payoffRatio,
    });

    // fractionSuggested null = sample insuffisant côté KellySizingService (ne devrait
    // plus arriver vu notre garde n_closed>=30, mais on protège).
    const fraction = result.fractionSuggested ?? 0;
    const edgeNegative = result.fullKelly <= 0;

    let notionalUsd: number;
    let source: string;

    if (edgeNegative || fraction === 0) {
      // PR #359 — si edge négatif ET WR observé < 20% sur sample suffisant, on
      // descend à $800 au lieu de $1575 pour limiter le saignement (jour 19 mai
      // PnL -$534 avec WR 12.9%). Sinon baseline historique conservé.
      if (stats.wr < LOW_WR_THRESHOLD && stats.n_closed >= LOW_WR_MIN_SAMPLE) {
        notionalUsd = NOTIONAL_REDUCED_USD;
        source = 'auto_recompute_reduced_low_wr';
      } else {
        notionalUsd = NOTIONAL_FALLBACK_USD;
        source = 'auto_recompute_no_edge';
      }
    } else {
      const raw = fraction * this.capitalUsd;
      notionalUsd = Math.max(NOTIONAL_MIN, Math.min(NOTIONAL_MAX, raw));
      source = 'auto_recompute';
    }

    await this.upsertConfig({
      asset_class: assetClass,
      notional_usd: notionalUsd,
      kelly_fraction: edgeNegative ? 0 : fraction,
      win_rate_observed: stats.wr,
      win_rate_wilson_lower: result.winRateLowerWilson,
      payoff_ratio: payoffRatio,
      sample_size: stats.n_closed,
      source,
    });

    this.logger.log(
      `[Kelly] ${assetClass} fraction=${(fraction * 100).toFixed(2)}% notional=$${notionalUsd.toFixed(0)} n=${stats.n_closed} wr=${(stats.wr * 100).toFixed(1)}% wilson95L=${(result.winRateLowerWilson * 100).toFixed(2)}% payoff=${payoffRatio.toFixed(3)} source=${source}`,
    );
  }

  /**
   * Fetch les positions fermées 14j filtrées (outliers R5 exclus) puis aggrège
   * côté JS (Supabase JS n a pas de SUM/AVG natif sans .rpc()).
   */
  private async fetchClassStats(assetClass: string): Promise<ClassStats | null> {
    const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data, error } = await this.supabase
        .getClient()
        .from('lisa_positions')
        .select('status, realized_pnl_pct, exit_price, entry_price')
        .eq('portfolio_id', this.portfolioId)
        .eq('asset_class', assetClass)
        .like('status', 'closed%')
        .gte('created_at', sinceIso)
        .gt('realized_pnl_pct', -50)
        .limit(2000);

      if (error) {
        this.logger.warn(`[Kelly] ${assetClass} stats query failed: ${error.message}`);
        return null;
      }

      const rows = (data ?? []) as Array<{
        status: string;
        realized_pnl_pct: number | null;
        exit_price: number | null;
        entry_price: number | null;
      }>;

      // Garde supplémentaire R5 : exit_price > entry × 0.5 (le filter -50 le couvre
      // déjà mathématiquement, mais on garde la garde explicite pour audit).
      const safe = rows.filter((r) => {
        if (r.entry_price == null || r.exit_price == null) return true;
        return r.exit_price > r.entry_price * 0.5;
      });

      const n_closed = safe.length;
      if (n_closed === 0) {
        return { n_closed: 0, wr: 0, tp_avg_pct: null, sl_avg_pct: null };
      }

      const tpRows = safe.filter((r) => r.status === 'closed_target');
      const slRows = safe.filter((r) => r.status === 'closed_stop');
      const wr = tpRows.length / n_closed;

      const avg = (xs: Array<{ realized_pnl_pct: number | null }>): number | null => {
        const vals = xs.map((r) => r.realized_pnl_pct).filter((v): v is number => Number.isFinite(v as number));
        if (vals.length === 0) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };

      return {
        n_closed,
        wr,
        tp_avg_pct: avg(tpRows),
        sl_avg_pct: avg(slRows),
      };
    } catch (err) {
      this.logger.warn(`[Kelly] ${assetClass} stats exception: ${(err as Error).message}`);
      return null;
    }
  }

  private computePayoffRatio(tpAvgPct: number | null, slAvgPct: number | null): number | null {
    if (tpAvgPct == null || slAvgPct == null) return null;
    if (slAvgPct === 0) return null;
    const ratio = Math.abs(tpAvgPct) / Math.abs(slAvgPct);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }

  private async upsertConfig(payload: {
    asset_class: string;
    notional_usd: number;
    kelly_fraction: number;
    win_rate_observed: number;
    win_rate_wilson_lower: number;
    payoff_ratio: number;
    sample_size: number;
    source: string;
  }): Promise<void> {
    const { error } = await this.supabase
      .getClient()
      .from('asset_class_kelly_config')
      .upsert(
        {
          ...payload,
          computed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'asset_class' },
      );
    if (error) {
      this.logger.warn(`[Kelly] upsert failed for ${payload.asset_class}: ${error.message}`);
    }
  }
}
