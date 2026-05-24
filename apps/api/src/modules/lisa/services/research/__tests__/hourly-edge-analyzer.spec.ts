import {
  computeBucketStats,
  generateSuggestions,
  parseCurrentBlacklist,
  DEFAULT_ANALYZER_THRESHOLDS,
  type ClosedTrade,
} from '../hourly-edge-analyzer.helper';

function makeTrade(asset_class: string, hour: number, pnl_pct: number, status: string): ClosedTrade {
  return {
    asset_class,
    entry_hour_utc: hour,
    realized_pnl_usd: pnl_pct * 8, // notional ~ $787 → pnl_usd ≈ pct × 8
    realized_pnl_pct: pnl_pct,
    status,
  };
}

describe('computeBucketStats', () => {
  it('ignore les buckets avec sample < min_sample_size', () => {
    const trades = Array.from({ length: 19 }, () => makeTrade('asia_equity', 0, -2, 'closed_stop'));
    const stats = computeBucketStats(trades);
    expect(stats.length).toBe(0);
  });

  it('détecte le bucket "should_blacklist" sur pattern asia H00', () => {
    // 25 trades asia @ H00, 18 stops (-3%), 4 invalidated (0%), 3 targets (+2%)
    const trades: ClosedTrade[] = [
      ...Array.from({ length: 18 }, () => makeTrade('asia_equity', 0, -3, 'closed_stop')),
      ...Array.from({ length: 4 }, () => makeTrade('asia_equity', 0, 0, 'closed_invalidated')),
      ...Array.from({ length: 3 }, () => makeTrade('asia_equity', 0, 2, 'closed_target')),
    ];
    const stats = computeBucketStats(trades);
    expect(stats).toHaveLength(1);
    expect(stats[0].asset_class).toBe('asia_equity');
    expect(stats[0].hour_utc).toBe(0);
    expect(stats[0].win_rate_pct).toBe(12); // 3/25
    expect(stats[0].stop_rate_pct).toBe(72); // 18/25
    expect(stats[0].verdict).toBe('should_blacklist');
  });

  it('détecte le bucket "should_unblacklist" si pattern devient profitable', () => {
    // 35 trades us_equity_large @ H17 (currently blacklist H17,18), 22 wins, sum +$500
    const trades: ClosedTrade[] = [
      ...Array.from({ length: 22 }, () => makeTrade('us_equity_large', 17, 2.5, 'closed_target')),
      ...Array.from({ length: 13 }, () => makeTrade('us_equity_large', 17, -1.5, 'closed_stop')),
    ];
    const stats = computeBucketStats(trades);
    expect(stats[0].win_rate_pct).toBeCloseTo(62.9, 1);
    expect(stats[0].sum_usd).toBeGreaterThan(0);
    expect(stats[0].verdict).toBe('should_unblacklist');
  });

  it('verdict neutre si pas dans seuils ni dans l\'autre sens', () => {
    // 25 trades, WR 48%, stop_rate 50%, sum modeste positive
    const trades: ClosedTrade[] = [
      ...Array.from({ length: 12 }, () => makeTrade('eu_equity', 14, 1.5, 'closed_target')),
      ...Array.from({ length: 13 }, () => makeTrade('eu_equity', 14, -1.2, 'closed_stop')),
    ];
    const stats = computeBucketStats(trades);
    expect(stats[0].verdict).toBe('neutral');
  });

  it('group par asset_class × hour correctement', () => {
    const trades: ClosedTrade[] = [
      ...Array.from({ length: 20 }, () => makeTrade('asia_equity', 0, -2, 'closed_stop')),
      ...Array.from({ length: 20 }, () => makeTrade('asia_equity', 1, -2, 'closed_stop')),
      ...Array.from({ length: 20 }, () => makeTrade('us_equity_large', 17, -2, 'closed_stop')),
    ];
    const stats = computeBucketStats(trades);
    expect(stats).toHaveLength(3);
  });

  it('seuils customisables', () => {
    const trades: ClosedTrade[] = Array.from({ length: 21 }, () => makeTrade('asia_equity', 0, -1, 'closed_stop'));
    const stats = computeBucketStats(trades, {
      ...DEFAULT_ANALYZER_THRESHOLDS,
      blacklist_max_sum_usd: -10, // seuil très permissif
    });
    expect(stats[0].verdict).toBe('should_blacklist'); // -1pct × $8 × 21 = -$168 < -10
  });
});

describe('generateSuggestions', () => {
  it('add suggestion si bucket should_blacklist + pas dans current blacklist', () => {
    const stats = [
      {
        asset_class: 'eu_equity',
        hour_utc: 14,
        n: 25,
        win_rate_pct: 30,
        stop_rate_pct: 65,
        mean_pnl_pct: -1.5,
        sum_usd: -300,
        verdict: 'should_blacklist' as const,
      },
    ];
    const currentBlacklist = new Map<string, Set<number>>([
      ['eu_equity', new Set([])],
    ]);
    const result = generateSuggestions(stats, currentBlacklist);
    expect(result.add).toHaveLength(1);
    expect(result.add[0].asset_class).toBe('eu_equity');
    expect(result.add[0].hour_utc).toBe(14);
    expect(result.remove).toHaveLength(0);
  });

  it('PAS de duplicate add si déjà dans blacklist', () => {
    const stats = [
      {
        asset_class: 'asia_equity',
        hour_utc: 0,
        n: 25,
        win_rate_pct: 25,
        stop_rate_pct: 70,
        mean_pnl_pct: -2.5,
        sum_usd: -500,
        verdict: 'should_blacklist' as const,
      },
    ];
    const currentBlacklist = new Map<string, Set<number>>([
      ['asia_equity', new Set([0, 1, 2])], // déjà gate
    ]);
    const result = generateSuggestions(stats, currentBlacklist);
    expect(result.add).toHaveLength(0);
  });

  it('remove suggestion si bucket should_unblacklist + dans current blacklist', () => {
    const stats = [
      {
        asset_class: 'us_equity_large',
        hour_utc: 17,
        n: 35,
        win_rate_pct: 65,
        stop_rate_pct: 30,
        mean_pnl_pct: 0.8,
        sum_usd: 400,
        verdict: 'should_unblacklist' as const,
      },
    ];
    const currentBlacklist = new Map<string, Set<number>>([
      ['us_equity_large', new Set([17, 18])],
    ]);
    const result = generateSuggestions(stats, currentBlacklist);
    expect(result.remove).toHaveLength(1);
    expect(result.remove[0].hour_utc).toBe(17);
  });

  it('summary "No changes" si rien à proposer', () => {
    const stats = [
      {
        asset_class: 'eu_equity',
        hour_utc: 10,
        n: 20,
        win_rate_pct: 50,
        stop_rate_pct: 40,
        mean_pnl_pct: 0.1,
        sum_usd: 30,
        verdict: 'neutral' as const,
      },
    ];
    const result = generateSuggestions(stats, new Map());
    expect(result.add).toHaveLength(0);
    expect(result.remove).toHaveLength(0);
    expect(result.summary).toMatch(/No changes recommended/);
  });
});

describe('parseCurrentBlacklist', () => {
  it('parse env vide → map avec Sets vides', () => {
    const m = parseCurrentBlacklist({});
    expect(m.get('asia_equity')?.size).toBe(0);
    expect(m.get('us_equity_large')?.size).toBe(0);
    expect(m.get('eu_equity')?.size).toBe(0);
  });

  it('parse env asia + US correctement', () => {
    const m = parseCurrentBlacklist({
      GAINERS_HOUR_BLACKLIST_ASIA_UTC: '0,1,2',
      GAINERS_HOUR_BLACKLIST_US_UTC: '17,18',
    });
    expect([...m.get('asia_equity') ?? new Set()].sort()).toEqual([0, 1, 2]);
    expect([...m.get('us_equity_large') ?? new Set()].sort()).toEqual([17, 18]);
    expect([...m.get('us_equity_small_mid') ?? new Set()].sort()).toEqual([17, 18]);
    expect(m.get('eu_equity')?.size).toBe(0);
  });
});
