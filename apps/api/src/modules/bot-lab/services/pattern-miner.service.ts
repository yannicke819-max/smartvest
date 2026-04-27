import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BOT_LAB_CONSTANTS } from '../types/bot-lab.types';
import type { PatternKind, PatternStatus } from '../types/bot-lab.types';

/**
 * PatternMinerService — Phase 3 du Bot Lab.
 *
 * Extrait des patterns récurrents depuis les trades fermés des bots du
 * user, calcule leur score de robustesse cross-régimes et un score
 * composite.
 *
 * Approche pragmatique pour Phase 3 :
 *  1. Group les trades par signature (asset_class + direction + vix_bucket
 *     + regime). Une signature = un cluster.
 *  2. Filtre clusters avec ≥ MIN_OBSERVATIONS_FOR_VALIDATION trades.
 *  3. Pour chaque cluster, calcule :
 *     - Stats globales (win rate, expectancy, max DD)
 *     - Robustness score (variance perf cross-regimes)
 *     - Composite score (robustness × log(obs) × edge × dd_factor)
 *  4. Upsert dans bot_patterns avec status 'candidate' ou 'validated'.
 *
 * Phase 4 lira ces patterns + lisa_pattern_adoptions pour les exposer
 * à Lisa selon le niveau d'adoption (observe/suggest/enforce).
 */

interface TradeForMining {
  bot_id: string;
  symbol: string;
  asset_class: string;
  direction: string;
  market_regime: string | null;
  vix_at_entry: number | null;
  net_pnl_usd: number;
  entry_timestamp: string;
  exit_timestamp: string;
}

interface ClusterStats {
  signature: string;
  conditions: Record<string, unknown>;
  trades: TradeForMining[];
  totalPnl: number;
  winRate: number;
  expectancy: number;
  maxDrawdown: number;
  perfByRegime: Map<string, { count: number; pnl: number; winRate: number }>;
  robustnessScore: number;
  compositeScore: number;
}

@Injectable()
export class PatternMinerService {
  private readonly logger = new Logger(PatternMinerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Mine les patterns à partir de tous les bots du user.
   * Retourne le nombre de patterns créés/mis à jour.
   */
  async mineFromUserBots(userId: string): Promise<{ minedCount: number; createdCount: number; updatedCount: number }> {
    // 1. Récupère tous les bots du user
    const { data: bots } = await this.supabase.getClient()
      .from('bot_definitions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (!bots || bots.length === 0) {
      return { minedCount: 0, createdCount: 0, updatedCount: 0 };
    }

    const botIds = bots.map((b) => b.id as string);

    // 2. Récupère tous les trades fermés des bots du user
    const { data: trades } = await this.supabase.getClient()
      .from('bot_paper_trades')
      .select('bot_id, symbol, asset_class, direction, market_regime, vix_at_entry, net_pnl_usd, entry_timestamp, exit_timestamp')
      .in('bot_id', botIds)
      .not('exit_timestamp', 'is', null);

    if (!trades || trades.length < BOT_LAB_CONSTANTS.MIN_OBSERVATIONS_FOR_VALIDATION) {
      this.logger.log(`[PATTERN_MINER] user=${userId.slice(0, 8)} insufficient trades (${trades?.length ?? 0})`);
      return { minedCount: 0, createdCount: 0, updatedCount: 0 };
    }

    const minableTrades: TradeForMining[] = trades.map((t) => ({
      bot_id: t.bot_id as string,
      symbol: t.symbol as string,
      asset_class: t.asset_class as string,
      direction: t.direction as string,
      market_regime: t.market_regime as string | null,
      vix_at_entry: t.vix_at_entry != null ? Number(t.vix_at_entry) : null,
      net_pnl_usd: parseFloat(String(t.net_pnl_usd ?? 0)),
      entry_timestamp: t.entry_timestamp as string,
      exit_timestamp: t.exit_timestamp as string,
    }));

    // 3. Cluster par signature
    const clusters = this.clusterBySignature(minableTrades);
    const validClusters = clusters.filter((c) =>
      c.trades.length >= BOT_LAB_CONSTANTS.MIN_OBSERVATIONS_FOR_VALIDATION,
    );

    this.logger.log(
      `[PATTERN_MINER] user=${userId.slice(0, 8)} ${minableTrades.length} trades → ${clusters.length} clusters → ${validClusters.length} avec >= ${BOT_LAB_CONSTANTS.MIN_OBSERVATIONS_FOR_VALIDATION} trades`,
    );

    // 4. Compute stats + scores pour chaque cluster valide
    let createdCount = 0;
    let updatedCount = 0;
    for (const cluster of validClusters) {
      this.computeClusterStats(cluster);
      const result = await this.upsertPattern(userId, cluster);
      if (result === 'created') createdCount++;
      else if (result === 'updated') updatedCount++;
    }

    return {
      minedCount: validClusters.length,
      createdCount,
      updatedCount,
    };
  }

  /**
   * Liste les patterns d'un user, triés par composite score décroissant.
   */
  async listPatterns(userId: string, status?: PatternStatus): Promise<Array<Record<string, unknown>>> {
    let query = this.supabase.getClient()
      .from('bot_patterns')
      .select('*')
      .eq('user_id', userId)
      .order('composite_score', { ascending: false, nullsFirst: false });

    if (status) {
      query = query.eq('status', status);
    }

    const { data } = await query;
    return data ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // CLUSTERING
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Group trades par signature : asset_class + direction + vix_bucket.
   * Le regime n'est PAS dans la signature pour permettre le calcul de
   * variance cross-régimes (sinon chaque signature aurait 1 seul régime).
   *
   * Signatures exemples :
   *   "equity_us_large|long|vix_low"
   *   "crypto|long|vix_normal"
   *   "commodities_metals_precious|short|vix_high"
   */
  private clusterBySignature(trades: TradeForMining[]): ClusterStats[] {
    const map = new Map<string, ClusterStats>();

    for (const trade of trades) {
      const vixBucket = this.vixToBucket(trade.vix_at_entry);
      const signature = `${trade.asset_class}|${trade.direction}|${vixBucket}`;

      if (!map.has(signature)) {
        map.set(signature, {
          signature,
          conditions: {
            asset_class: trade.asset_class,
            direction: trade.direction,
            vix_bucket: vixBucket,
          },
          trades: [],
          totalPnl: 0,
          winRate: 0,
          expectancy: 0,
          maxDrawdown: 0,
          perfByRegime: new Map(),
          robustnessScore: 0,
          compositeScore: 0,
        });
      }

      map.get(signature)!.trades.push(trade);
    }

    return Array.from(map.values());
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCORING
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Calcule les stats d'un cluster + robustness + composite score.
   * Mute le cluster directement.
   */
  private computeClusterStats(cluster: ClusterStats): void {
    const trades = cluster.trades;
    let wins = 0;
    let totalPnl = 0;
    let cumul = 0;
    let peak = 0;
    let maxDrawdown = 0;

    // Group par régime pour le calcul de robustesse
    const byRegime = new Map<string, { count: number; pnl: number; wins: number }>();

    for (const t of trades) {
      totalPnl += t.net_pnl_usd;
      if (t.net_pnl_usd > 0) wins++;

      cumul += t.net_pnl_usd;
      if (cumul > peak) peak = cumul;
      const dd = peak > 0 ? ((peak - cumul) / peak) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;

      const regime = t.market_regime ?? 'unknown';
      if (!byRegime.has(regime)) {
        byRegime.set(regime, { count: 0, pnl: 0, wins: 0 });
      }
      const stats = byRegime.get(regime)!;
      stats.count++;
      stats.pnl += t.net_pnl_usd;
      if (t.net_pnl_usd > 0) stats.wins++;
    }

    cluster.totalPnl = totalPnl;
    cluster.winRate = (wins / trades.length) * 100;
    cluster.expectancy = totalPnl / trades.length;
    cluster.maxDrawdown = maxDrawdown;

    // Stocker perf par régime
    for (const [regime, s] of byRegime.entries()) {
      cluster.perfByRegime.set(regime, {
        count: s.count,
        pnl: s.pnl,
        winRate: (s.wins / s.count) * 100,
      });
    }

    // Robustness score : ratio des régimes profitables / total des régimes
    // Plus le pattern marche dans plusieurs régimes, plus il est robuste.
    // Min 2 régimes requis pour scorer (sinon undefined).
    cluster.robustnessScore = this.computeRobustness(cluster);

    // Composite score : combinaison de plusieurs facteurs
    cluster.compositeScore = this.computeComposite(cluster);
  }

  /**
   * Robustness score (0-100) :
   *  - 100 si le pattern est rentable dans TOUS les régimes (variance min)
   *  - 0 si rentable dans 1 seul régime sur N
   *
   * Calculé comme : (regimes_profitable / regimes_with_min_sample) × 100
   * où min_sample = 5 trades par régime pour être considéré significatif.
   */
  private computeRobustness(cluster: ClusterStats): number {
    const MIN_SAMPLE_PER_REGIME = 5;
    const regimes = Array.from(cluster.perfByRegime.entries())
      .filter(([, s]) => s.count >= MIN_SAMPLE_PER_REGIME);

    if (regimes.length < 2) {
      // Pas assez de régimes pour évaluer robustesse → score conservateur 50
      return 50;
    }

    const profitableRegimes = regimes.filter(([, s]) => s.pnl > 0).length;
    const totalRegimes = regimes.length;

    return (profitableRegimes / totalRegimes) * 100;
  }

  /**
   * Composite score (0-100) — combine 4 facteurs :
   *  1. Robustness (0-100, 30% du score)
   *  2. Edge size : winRate - 50 (0-50 mappé sur 0-100, 25%)
   *  3. Sample size : log10(observations) / 3 × 100 (25%)
   *  4. Drawdown factor : (1 - max_dd/100) × 100 (20%)
   *
   * Score interprétable : 0-30 fragile, 30-50 prometteur, 50-70 solide,
   * 70+ exceptionnel.
   */
  private computeComposite(cluster: ClusterStats): number {
    const robustness = cluster.robustnessScore;
    const edge = Math.max(0, Math.min(100, (cluster.winRate - 50) * 2)); // 50% → 0, 75%+ → 50, 100% → 100
    const sampleSize = Math.min(100, (Math.log10(cluster.trades.length) / 3) * 100);
    const ddFactor = Math.max(0, 100 - cluster.maxDrawdown);

    return (
      robustness * 0.30 +
      edge * 0.25 +
      sampleSize * 0.25 +
      ddFactor * 0.20
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // PERSISTANCE
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Upsert un pattern dans la DB. Idempotent par (user_id, signature)
   * — recherché manuellement car pas de UNIQUE constraint en DB.
   */
  private async upsertPattern(userId: string, cluster: ClusterStats): Promise<'created' | 'updated' | 'noop'> {
    // Lookup par signature dans les conditions
    const { data: existing } = await this.supabase.getClient()
      .from('bot_patterns')
      .select('id')
      .eq('user_id', userId)
      .filter('conditions->>asset_class', 'eq', cluster.conditions.asset_class as string)
      .filter('conditions->>direction', 'eq', cluster.conditions.direction as string)
      .filter('conditions->>vix_bucket', 'eq', cluster.conditions.vix_bucket as string)
      .maybeSingle();

    const sourceBotIds = Array.from(new Set(cluster.trades.map((t) => t.bot_id)));
    const firstObserved = cluster.trades.reduce((min, t) => {
      const ts = new Date(t.entry_timestamp).getTime();
      return ts < min ? ts : min;
    }, Infinity);
    const lastObserved = cluster.trades.reduce((max, t) => {
      const ts = new Date(t.exit_timestamp).getTime();
      return ts > max ? ts : max;
    }, 0);

    // Status : validated si compositeScore > 50 et observations > MIN_VALIDATION × 1.5
    const status: PatternStatus =
      cluster.compositeScore > 50 && cluster.trades.length >= BOT_LAB_CONSTANTS.MIN_OBSERVATIONS_FOR_VALIDATION * 1.5
        ? 'validated'
        : 'candidate';

    const name = this.generatePatternName(cluster);
    const description = this.generatePatternDescription(cluster);

    const row = {
      user_id: userId,
      name,
      description,
      pattern_kind: 'entry_setup' as PatternKind,
      source_bot_ids: sourceBotIds,
      conditions: cluster.conditions,
      action_signal: {
        action: cluster.conditions.direction === 'long' ? 'open_long' : 'open_short',
        asset_class: cluster.conditions.asset_class,
      },
      observation_count: cluster.trades.length,
      win_rate_pct: cluster.winRate,
      expectancy_usd: cluster.expectancy.toFixed(2),
      robustness_score: cluster.robustnessScore,
      composite_score: cluster.compositeScore,
      first_observed_at: new Date(firstObserved).toISOString(),
      last_observed_at: new Date(lastObserved).toISOString(),
      status,
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await this.supabase.getClient()
        .from('bot_patterns')
        .update(row)
        .eq('id', existing.id as string);
      if (error) {
        this.logger.warn(`upsertPattern update failed: ${error.message}`);
        return 'noop';
      }
      return 'updated';
    } else {
      const { error } = await this.supabase.getClient()
        .from('bot_patterns')
        .insert(row);
      if (error) {
        this.logger.warn(`upsertPattern insert failed: ${error.message}`);
        return 'noop';
      }
      return 'created';
    }
  }

  /**
   * Génère un nom lisible pour un pattern à partir de sa signature.
   */
  private generatePatternName(cluster: ClusterStats): string {
    const ac = (cluster.conditions.asset_class as string).replace(/_/g, ' ');
    const dir = cluster.conditions.direction as string;
    const vix = cluster.conditions.vix_bucket as string;
    return `${dir.toUpperCase()} ${ac} en ${vix}`;
  }

  /**
   * Génère une description lisible avec stats clés.
   */
  private generatePatternDescription(cluster: ClusterStats): string {
    const winRate = cluster.winRate.toFixed(0);
    const expectancy = cluster.expectancy.toFixed(2);
    const obs = cluster.trades.length;
    const robustness = cluster.robustnessScore.toFixed(0);
    const composite = cluster.compositeScore.toFixed(0);
    const regimes = Array.from(cluster.perfByRegime.entries())
      .filter(([, s]) => s.count >= 5)
      .map(([r, s]) => `${r}(${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(0)})`)
      .join(', ');

    return `${obs} trades · win rate ${winRate}% · expectancy $${expectancy}/trade · robustness ${robustness}% · composite ${composite}/100${regimes ? ' — par régime: ' + regimes : ''}`;
  }

  /**
   * Helper : VIX → bucket.
   */
  private vixToBucket(vix: number | null): string {
    if (vix == null) return 'vix_unknown';
    if (vix < 15) return 'vix_low';
    if (vix < 22) return 'vix_normal';
    if (vix < 30) return 'vix_high';
    return 'vix_extreme';
  }
}
