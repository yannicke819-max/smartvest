import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { EodhdIntradayService } from './eodhd-intraday.service';
import { bootstrapMeanCI, verdictFromCI, GateVerdict } from '@smartvest/ai-analyst';

/**
 * GainersUserShadowService — PR #280
 *
 * Mesure le regret-cost des gates user-pipeline (path_eff, persistence,
 * cooldown, etc.). Distinct du shadow V1 BLOC1 (gainers_v1_shadow_signals)
 * qui est pour la migration ADR-005.
 *
 * Workflow :
 *   1. À chaque gate dans TopGainersScannerService.scanPortfolio, le
 *      scanner appelle `recordDecision(...)` avec le candidat + raison.
 *   2. simulatePending() (appelé en début de chaque cycle scanner) walk-
 *      forward sur candles 5m EODHD pour trouver TP_HIT / SL_HIT / TIME_LIMIT.
 *   3. getRegretSummary() aggrège par gate × grille avec bootstrap CI 95%
 *      sur sim_pnl_pct → verdict GATE_TOO_STRICT / GATE_HEALTHY / INCONCLUSIVE.
 *
 * Slippage haircut : 30bps round-trip (15bps × 2) sur chaque pnl_pct simulé,
 * soustrait avant persistence.
 */

export type ShadowDecision =
  | 'accept'
  | 'reject_path_eff'
  | 'reject_persistence'
  | 'reject_cooldown'
  | 'reject_post_sl_cooldown'
  | 'reject_p_win'
  | 'reject_budget_cap'
  | 'reject_no_tf_data'
  | 'reject_other';

export interface RecordDecisionInput {
  portfolioId: string;
  symbol: string;          // ex "WFCF.US" or "AAPL"
  assetClass: string;      // 'us_equity_small_mid' etc.
  isAsia: boolean;
  changePct1m: number | null;
  score: number | null;
  pathEff: number | null;
  persistenceScore: number | null;
  persistenceCount: string | null;  // "5/6"
  entryPrice: number | null;
  notionalUsd: number;
  decision: ShadowDecision;
  cfg: {
    minPathEff: number | null;
    minPersistence: number | null;
    asiaBoost: number | null;
    tpPct: number;
    slPct: number;
  };
}

interface SimGrid {
  key: string;
  tpPct: number;
  slPct: number;
  windowMin: number;
}

const SIM_GRIDS: SimGrid[] = [
  { key: 'baseline_30m', tpPct: 0.020, slPct: 0.009, windowMin: 30 },
  { key: 'baseline_60m', tpPct: 0.020, slPct: 0.009, windowMin: 60 },
  { key: 'alt15_30m',    tpPct: 0.015, slPct: 0.006, windowMin: 30 },
  { key: 'alt15_60m',    tpPct: 0.015, slPct: 0.006, windowMin: 60 },
];

const SLIPPAGE_HAIRCUT_BILATERAL = 0.0015;  // 15bps each side
const SLIPPAGE_TOTAL = SLIPPAGE_HAIRCUT_BILATERAL * 2;  // 30bps round-trip
const SIMULATE_AFTER_MIN = 60;  // attendre que la fenêtre 60m soit close
const SIMULATE_BATCH_SIZE = 50;

interface SimOutcome {
  outcome: 'TP_HIT' | 'SL_HIT' | 'TIME_LIMIT' | 'NO_DATA';
  exit_price: number | null;
  exit_at: string | null;
  pnl_pct: number | null;       // NET (slippage already subtracted)
  hit_at_min: number | null;
}

@Injectable()
export class GainersUserShadowService {
  private readonly logger = new Logger(GainersUserShadowService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly eodhd: EodhdIntradayService,
  ) {}

  /**
   * Capture une décision (ACCEPT ou REJECT) au moment où le scanner traverse
   * un gate. Fire-and-forget : non-bloquant, erreur loggée mais n'arrête pas
   * le cycle scanner.
   */
  async recordDecision(input: RecordDecisionInput): Promise<void> {
    try {
      await this.supabase.getClient().from('gainers_user_shadow_signals').insert({
        portfolio_id: input.portfolioId,
        symbol: input.symbol,
        asset_class: input.assetClass,
        change_pct_1m: input.changePct1m,
        score: input.score,
        path_eff: input.pathEff,
        persistence_score: input.persistenceScore,
        persistence_count: input.persistenceCount,
        entry_price: input.entryPrice,
        notional_usd: input.notionalUsd,
        decision: input.decision,
        cfg_min_path_eff: input.cfg.minPathEff,
        cfg_min_persistence: input.cfg.minPersistence,
        cfg_asia_boost: input.cfg.asiaBoost,
        cfg_tp_pct: input.cfg.tpPct,
        cfg_sl_pct: input.cfg.slPct,
        is_asia: input.isAsia,
      });
    } catch (e) {
      this.logger.warn(`[user-shadow] recordDecision failed for ${input.symbol}: ${String(e).slice(0, 100)}`);
    }
  }

  /**
   * Pick rows where sim_run_at IS NULL AND created_at > 60 min ago,
   * fetch 5m candles forward, walk-forward to find TP/SL hits sur 4 grilles.
   * Cap batch à SIMULATE_BATCH_SIZE pour éviter timeouts.
   */
  async simulatePending(): Promise<{ processed: number; failures: number }> {
    const cutoff = new Date(Date.now() - SIMULATE_AFTER_MIN * 60_000).toISOString();
    const { data: rows, error } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .select('id, symbol, asset_class, entry_price, created_at')
      .is('sim_run_at', null)
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(SIMULATE_BATCH_SIZE);

    if (error) {
      this.logger.warn(`[user-shadow] simulatePending query failed: ${error.message}`);
      return { processed: 0, failures: 1 };
    }
    if (!rows || rows.length === 0) return { processed: 0, failures: 0 };

    let processed = 0;
    let failures = 0;
    for (const row of rows) {
      try {
        const simResults = await this.simulateRow({
          symbol: String(row.symbol),
          assetClass: String(row.asset_class),
          entryPrice: row.entry_price != null ? Number(row.entry_price) : null,
          createdAt: String(row.created_at),
        });
        await this.supabase.getClient()
          .from('gainers_user_shadow_signals')
          .update({
            sim_results: simResults,
            sim_run_at: new Date().toISOString(),
            sim_window_max_min: 60,
          })
          .eq('id', row.id);
        processed++;
      } catch (e) {
        failures++;
        this.logger.warn(`[user-shadow] simulate ${row.symbol} failed: ${String(e).slice(0, 100)}`);
        // Mark as run with empty results to avoid infinite retry
        await this.supabase.getClient()
          .from('gainers_user_shadow_signals')
          .update({ sim_results: { error: String(e).slice(0, 200) }, sim_run_at: new Date().toISOString() })
          .eq('id', row.id)
          .catch(() => { /* nothing */ });
      }
    }
    if (processed > 0 || failures > 0) {
      this.logger.log(`[user-shadow] simulated ${processed} rows (${failures} failures)`);
    }
    return { processed, failures };
  }

  private async simulateRow(args: {
    symbol: string;
    assetClass: string;
    entryPrice: number | null;
    createdAt: string;
  }): Promise<Record<string, SimOutcome>> {
    const results: Record<string, SimOutcome> = {};
    const noEntry = (): SimOutcome => ({
      outcome: 'NO_DATA', exit_price: null, exit_at: null, pnl_pct: null, hit_at_min: null,
    });

    if (args.entryPrice == null || args.entryPrice <= 0) {
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      return results;
    }

    // Crypto = no support yet (would need Binance klines), skip gracefully
    if (args.assetClass === 'crypto_major' || args.assetClass === 'crypto_alt') {
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      return results;
    }

    // Le scanner stocke le symbol avec suffix exchange déjà appliqué
    // ("WFCF.US", "017550.KO", "AAZ.LSE"). On garde le symbol tel quel
    // — getCandles applique normalizeForEodhdIntraday + fallback .US si
    // le suffix manquait par erreur.
    const eodhdTicker = args.symbol;

    // Fetch ~13 candles 5m = 65 min window (enough for 60m grid)
    const series = await this.eodhd.getCandles(eodhdTicker, '5m', 15).catch(() => null);
    if (!series || series.candles.length === 0) {
      for (const g of SIM_GRIDS) results[g.key] = noEntry();
      return results;
    }

    const startTs = new Date(args.createdAt).getTime() / 1000;
    const forward = series.candles.filter((c) => c.timestamp >= startTs);

    for (const grid of SIM_GRIDS) {
      results[grid.key] = this.walkForward(args.entryPrice, forward, startTs, grid);
    }
    return results;
  }

  private walkForward(
    entry: number,
    candles: Array<{ timestamp: number; high: number; low: number; close: number }>,
    startTs: number,
    grid: SimGrid,
  ): SimOutcome {
    const tpPrice = entry * (1 + grid.tpPct);
    const slPrice = entry * (1 - grid.slPct);
    const cutoffTs = startTs + grid.windowMin * 60;
    let lastBeforeCutoff: typeof candles[number] | null = null;

    for (const c of candles) {
      if (c.timestamp > cutoffTs) break;
      lastBeforeCutoff = c;
      // Conservative tie-break : SL prioritaire si les deux pourraient déclencher
      // dans la même candle 5m (impossible de savoir l'ordre sans tick data).
      if (c.low <= slPrice) {
        return {
          outcome: 'SL_HIT',
          exit_price: slPrice,
          exit_at: new Date(c.timestamp * 1000).toISOString(),
          pnl_pct: -grid.slPct - SLIPPAGE_TOTAL,
          hit_at_min: Math.round((c.timestamp - startTs) / 60),
        };
      }
      if (c.high >= tpPrice) {
        return {
          outcome: 'TP_HIT',
          exit_price: tpPrice,
          exit_at: new Date(c.timestamp * 1000).toISOString(),
          pnl_pct: grid.tpPct - SLIPPAGE_TOTAL,
          hit_at_min: Math.round((c.timestamp - startTs) / 60),
        };
      }
    }

    if (lastBeforeCutoff) {
      const closePnl = (lastBeforeCutoff.close - entry) / entry;
      return {
        outcome: 'TIME_LIMIT',
        exit_price: lastBeforeCutoff.close,
        exit_at: new Date(lastBeforeCutoff.timestamp * 1000).toISOString(),
        pnl_pct: closePnl - SLIPPAGE_TOTAL,
        hit_at_min: Math.round((lastBeforeCutoff.timestamp - startTs) / 60),
      };
    }
    return { outcome: 'NO_DATA', exit_price: null, exit_at: null, pnl_pct: null, hit_at_min: null };
  }

  /**
   * Aggregate par (decision × grid) avec bootstrap CI 95% sur pnl_pct.
   * cumulative_regret_usd = somme(pnl_pct × notional) — positif = on rate
   * de l'argent en moyenne, négatif = le gate sauve de l'argent.
   */
  async getRegretSummary(
    portfolioId: string,
    days: number = 7,
  ): Promise<RegretSummary> {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { data, error } = await this.supabase.getClient()
      .from('gainers_user_shadow_signals')
      .select('decision, sim_results, notional_usd')
      .eq('portfolio_id', portfolioId)
      .gte('created_at', since)
      .not('sim_results', 'is', null);

    if (error || !data) {
      return { since, days, byGate: [], totalRows: 0 };
    }

    type Bucket = { pnls: number[]; notional: number };
    const buckets = new Map<string, Bucket>();

    for (const row of data) {
      const sim = row.sim_results as Record<string, SimOutcome> | null;
      if (!sim || sim.error) continue;
      const notional = row.notional_usd != null ? Number(row.notional_usd) : 1000;
      for (const grid of SIM_GRIDS) {
        const o = sim[grid.key];
        if (!o || o.pnl_pct == null) continue;
        const key = `${row.decision}|${grid.key}`;
        if (!buckets.has(key)) buckets.set(key, { pnls: [], notional });
        buckets.get(key)!.pnls.push(Number(o.pnl_pct));
      }
    }

    const byGate: RegretGateRow[] = [];
    for (const [key, bucket] of buckets) {
      const [decision, grid] = key.split('|');
      const ci = bootstrapMeanCI(bucket.pnls);
      const verdict: GateVerdict = verdictFromCI(ci, { minN: 100 });
      const cumulative_regret_usd = bucket.pnls.reduce(
        (acc, p) => acc + p * bucket.notional, 0,
      );
      byGate.push({
        decision,
        grid,
        n: ci.n,
        mean_pnl_pct: ci.mean,
        ci_low: ci.ciLow,
        ci_high: ci.ciHigh,
        cumulative_regret_usd,
        verdict,
      });
    }

    byGate.sort((a, b) => {
      if (a.decision !== b.decision) return a.decision.localeCompare(b.decision);
      return a.grid.localeCompare(b.grid);
    });

    return { since, days, byGate, totalRows: data.length };
  }
}

export interface RegretGateRow {
  decision: string;
  grid: string;
  n: number;
  mean_pnl_pct: number;
  ci_low: number;
  ci_high: number;
  cumulative_regret_usd: number;
  verdict: GateVerdict;
}

export interface RegretSummary {
  since: string;
  days: number;
  totalRows: number;
  byGate: RegretGateRow[];
}
