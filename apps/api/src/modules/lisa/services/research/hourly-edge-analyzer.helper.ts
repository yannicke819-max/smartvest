/**
 * Hourly Edge Analyzer — recalcule chaque semaine quelles heures UTC sont
 * structurellement perdantes par asset_class, et suggère des updates aux
 * blacklists configurées.
 *
 * Logique pure, testable. Pas de I/O, pas de NestJS. Le service NestJS
 * (hourly-edge-analyzer.service.ts) injecte les data depuis lisa_positions
 * et persist les suggestions.
 *
 * Seuils par défaut (calibrés sur l'audit 23-24/05) :
 *   - Min sample par bucket : 20 trades (sinon ignored, sample trop faible)
 *   - Bucket "à blacklister" : WR < 40% ET stop_rate > 55% ET sum_usd < -200
 *   - Bucket "à dé-blacklister" : si déjà blacklist mais WR > 55% sur sample
 *
 * Sortie : { add: [...], remove: [...], summary }
 */

export interface ClosedTrade {
  asset_class: string;
  entry_hour_utc: number; // 0-23
  realized_pnl_usd: number;
  realized_pnl_pct: number;
  status: string; // 'closed_stop' | 'closed_target' | 'closed_invalidated' | ...
}

export interface HourBucketStats {
  asset_class: string;
  hour_utc: number;
  n: number;
  win_rate_pct: number;
  stop_rate_pct: number;
  mean_pnl_pct: number;
  sum_usd: number;
  verdict: 'should_blacklist' | 'should_unblacklist' | 'neutral';
}

export interface AnalyzerSuggestion {
  add: Array<{ asset_class: string; hour_utc: number; n: number; sum_usd: number; reason: string }>;
  remove: Array<{ asset_class: string; hour_utc: number; n: number; sum_usd: number; reason: string }>;
  summary: string;
  bucket_stats: HourBucketStats[];
}

export interface AnalyzerThresholds {
  min_sample_size: number;        // default 20
  blacklist_max_wr_pct: number;    // default 40
  blacklist_min_stop_rate: number; // default 55
  blacklist_max_sum_usd: number;   // default -200
  unblacklist_min_wr_pct: number;  // default 55
  unblacklist_min_sample: number;  // default 30 (plus strict pour retirer une blacklist)
}

export const DEFAULT_ANALYZER_THRESHOLDS: AnalyzerThresholds = {
  min_sample_size: 20,
  blacklist_max_wr_pct: 40,
  blacklist_min_stop_rate: 55,
  blacklist_max_sum_usd: -200,
  unblacklist_min_wr_pct: 55,
  unblacklist_min_sample: 30,
};

/**
 * Calcule les statistiques par bucket (asset_class × hour_utc).
 */
export function computeBucketStats(
  trades: ClosedTrade[],
  thresholds: AnalyzerThresholds = DEFAULT_ANALYZER_THRESHOLDS,
): HourBucketStats[] {
  const groups = new Map<string, ClosedTrade[]>();
  for (const t of trades) {
    const key = `${t.asset_class}|${t.entry_hour_utc}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const stats: HourBucketStats[] = [];
  for (const [key, arr] of groups.entries()) {
    const [asset_class, hourStr] = key.split('|');
    const hour_utc = Number.parseInt(hourStr, 10);
    const n = arr.length;
    if (n < thresholds.min_sample_size) continue;
    const winners = arr.filter((t) => t.realized_pnl_usd > 0).length;
    const stops = arr.filter((t) => t.status === 'closed_stop').length;
    const sum_usd = arr.reduce((s, t) => s + t.realized_pnl_usd, 0);
    const mean_pnl_pct = arr.reduce((s, t) => s + t.realized_pnl_pct, 0) / n;
    const win_rate_pct = (winners / n) * 100;
    const stop_rate_pct = (stops / n) * 100;

    let verdict: HourBucketStats['verdict'] = 'neutral';
    if (
      win_rate_pct < thresholds.blacklist_max_wr_pct &&
      stop_rate_pct > thresholds.blacklist_min_stop_rate &&
      sum_usd < thresholds.blacklist_max_sum_usd
    ) {
      verdict = 'should_blacklist';
    } else if (
      n >= thresholds.unblacklist_min_sample &&
      win_rate_pct > thresholds.unblacklist_min_wr_pct &&
      sum_usd > 0
    ) {
      verdict = 'should_unblacklist';
    }

    stats.push({
      asset_class,
      hour_utc,
      n,
      win_rate_pct: Math.round(win_rate_pct * 10) / 10,
      stop_rate_pct: Math.round(stop_rate_pct * 10) / 10,
      mean_pnl_pct: Math.round(mean_pnl_pct * 1000) / 1000,
      sum_usd: Math.round(sum_usd * 100) / 100,
      verdict,
    });
  }

  return stats.sort((a, b) => {
    if (a.asset_class !== b.asset_class) return a.asset_class.localeCompare(b.asset_class);
    return a.hour_utc - b.hour_utc;
  });
}

/**
 * Compare les stats vs la blacklist actuelle, génère add/remove suggestions.
 *
 * @param currentBlacklist Map<asset_class, Set<hour_utc>> de la config Fly actuelle
 */
export function generateSuggestions(
  stats: HourBucketStats[],
  currentBlacklist: Map<string, Set<number>>,
): AnalyzerSuggestion {
  const add: AnalyzerSuggestion['add'] = [];
  const remove: AnalyzerSuggestion['remove'] = [];

  for (const s of stats) {
    const isCurrentlyBlacklisted = currentBlacklist.get(s.asset_class)?.has(s.hour_utc) ?? false;

    if (s.verdict === 'should_blacklist' && !isCurrentlyBlacklisted) {
      add.push({
        asset_class: s.asset_class,
        hour_utc: s.hour_utc,
        n: s.n,
        sum_usd: s.sum_usd,
        reason: `WR ${s.win_rate_pct}% (<40), stop_rate ${s.stop_rate_pct}% (>55), sum ${s.sum_usd} (<-200)`,
      });
    } else if (s.verdict === 'should_unblacklist' && isCurrentlyBlacklisted) {
      remove.push({
        asset_class: s.asset_class,
        hour_utc: s.hour_utc,
        n: s.n,
        sum_usd: s.sum_usd,
        reason: `WR ${s.win_rate_pct}% (>55), sum +${s.sum_usd} positif`,
      });
    }
  }

  const summary =
    add.length === 0 && remove.length === 0
      ? `No changes recommended (analyzed ${stats.length} buckets)`
      : `${add.length} hours to ADD to blacklist, ${remove.length} hours to REMOVE (analyzed ${stats.length} buckets)`;

  return { add, remove, summary, bucket_stats: stats };
}

/**
 * Parse la blacklist actuelle depuis les env vars (mêmes que data-driven-gates).
 */
export function parseCurrentBlacklist(env: {
  GAINERS_HOUR_BLACKLIST_ASIA_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_US_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_EU_UTC?: string | undefined;
  GAINERS_HOUR_BLACKLIST_CRYPTO_UTC?: string | undefined;
}): Map<string, Set<number>> {
  const parse = (s: string | undefined): Set<number> => {
    if (!s || s.trim().length === 0) return new Set();
    return new Set(
      s.split(',').map((x) => x.trim()).filter((x) => /^\d{1,2}$/.test(x))
        .map((x) => Number.parseInt(x, 10)).filter((n) => n >= 0 && n <= 23),
    );
  };
  const asia = parse(env.GAINERS_HOUR_BLACKLIST_ASIA_UTC);
  const us = parse(env.GAINERS_HOUR_BLACKLIST_US_UTC);
  const eu = parse(env.GAINERS_HOUR_BLACKLIST_EU_UTC);
  const crypto = parse(env.GAINERS_HOUR_BLACKLIST_CRYPTO_UTC);
  return new Map([
    ['asia_equity', asia],
    ['us_equity_large', us],
    ['us_equity_small_mid', us],
    ['eu_equity', eu],
    ['crypto_major', crypto],
    ['crypto_alt', crypto],
  ]);
}
