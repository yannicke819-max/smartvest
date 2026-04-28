/**
 * P3-B — Tests runner avec fetcher synthétique.
 *
 * On injecte un fetchBars qui retourne des bougies déterministes pour
 * éviter tout I/O réseau. Le runner doit produire des rapports complets
 * + verdict + INSERT row.
 */
import {
  runBacktest,
  formatMarkdownReport,
  getUniverse,
  type RunnerArgs,
  type BacktestRunRow,
} from '../runner';
import type { Candle } from '../../strategies/rebound-tp';

// Setup capitulation reproductible
function capitulationBars(): Candle[] {
  // Étendu à 35 bougies pour passer la limite runner.length < 30 :
  // 25 stable + 4 drop + 1 reversal + 5 trailing pour la sortie.
  const closes = [
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100,             // 25 bars stables
    92, 88, 82, 85,                       // drop
  ];
  const bars: Candle[] = closes.map((close, i) => {
    const open = i === 0 ? close * 0.999 : closes[i - 1];
    return {
      timestamp: i,
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: i === closes.length - 1 ? 3500 : 1000,
    };
  });
  // 5 bougies de poursuite : gap up massif jour 29 → TP3 hit
  bars.push({ timestamp: 29, open: 90, high: 100, low: 90, close: 99, volume: 2000 });
  for (let i = 30; i < 35; i++) {
    bars.push({ timestamp: i, open: 99, high: 100, low: 98, close: 99, volume: 1000 });
  }
  return bars;
}

describe('runBacktest', () => {
  it('runs primary cfg, writes reports, returns selected variant', async () => {
    const writes: Array<{ filename: string; content: string }> = [];
    const inserts: BacktestRunRow[] = [];

    const args: RunnerArgs = {
      universe: 'sp500',
      start: '2024-01-01',
      end: '2026-01-01',
      cfg: 'default',
      fetchBars: async () => capitulationBars(),
      writeReport: async (filename, content) => {
        writes.push({ filename, content });
      },
      insertRun: async (row) => {
        inserts.push(row);
      },
    };
    const result = await runBacktest(args);

    expect(result.selectedVariant).toBe('default');
    expect(result.variants).toHaveLength(1);
    expect(result.trades.length).toBeGreaterThan(0);

    // Reports écrits
    expect(writes).toHaveLength(2);
    const json = writes.find((w) => w.filename.endsWith('.json'));
    const md = writes.find((w) => w.filename.endsWith('.md'));
    expect(json).toBeDefined();
    expect(md).toBeDefined();
    expect(JSON.parse(json!.content).selectedVariant).toBe('default');

    // Insert appelé
    expect(inserts).toHaveLength(1);
    expect(inserts[0].universe).toBe('sp500');
    expect(['GO', 'NO_GO']).toContain(inserts[0].verdict);
  });

  it('fail-fast when > 50% of fetches fail', async () => {
    let n = 0;
    const args: RunnerArgs = {
      universe: 'sp500',
      start: '2024-01-01',
      end: '2026-01-01',
      cfg: 'default',
      fetchBars: async () => {
        n++;
        return n % 2 === 0 ? capitulationBars() : null; // 50% fail
      },
      writeReport: async () => {},
    };
    // Avec ~50% de fail (limite stricte), peut passer ou fail selon round
    // donc on force >50% en retournant TOUS null
    const argsAllFail: RunnerArgs = {
      ...args,
      fetchBars: async () => null,
    };
    await expect(runBacktest(argsAllFail)).rejects.toThrow(/data provider down/);
  });

  it('runs auto-tune when primary NO_GO and tries 3 variants', async () => {
    const captured: string[] = [];
    const args: RunnerArgs = {
      universe: 'sp500',
      start: '2024-01-01',
      end: '2026-01-01',
      cfg: 'default',
      autoTune: true,
      fetchBars: async (ticker) => {
        captured.push(ticker);
        // Retourne une série flat sans signal → tous variants NO_GO ou
        // 0 trades → on vérifie juste que les 4 variants ont été tentés
        return Array.from({ length: 30 }, (_, i) => ({
          timestamp: i, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000,
        }));
      },
      writeReport: async () => {},
    };
    const result = await runBacktest(args);
    // 4 variants tentées (default + rsi_25 + vol_2_0 + dd_20)
    expect(result.variants).toHaveLength(4);
    const names = result.variants.map((v) => v.name);
    expect(names).toContain('default');
    expect(names).toContain('rsi_25');
    expect(names).toContain('vol_2_0');
    expect(names).toContain('dd_20');
  });

  it('does NOT run variants when primary GO', async () => {
    const args: RunnerArgs = {
      universe: 'sp500',
      start: '2024-01-01',
      end: '2026-01-01',
      cfg: 'default',
      autoTune: true,
      // Setup qui produit des trades GO (TP3 dominant)
      fetchBars: async () => capitulationBars(),
      writeReport: async () => {},
    };
    const result = await runBacktest(args);
    // Si verdict default GO → pas d'auto-tune. Si NO_GO → 4 variants.
    const primary = result.variants.find((v) => v.name === 'default');
    if (primary?.verdict.decision === 'GO') {
      expect(result.variants).toHaveLength(1);
    } else {
      expect(result.variants).toHaveLength(4);
    }
  });
});

describe('getUniverse', () => {
  it('returns sp500 subset', () => {
    const u = getUniverse('sp500');
    expect(u.length).toBeGreaterThan(20);
    expect(u).toContain('AAPL.US');
  });

  it('returns nasdaq100 subset', () => {
    const u = getUniverse('nasdaq100');
    expect(u.length).toBeGreaterThan(20);
    expect(u).toContain('NVDA.US');
  });

  it('returns dedup union for both', () => {
    const sp = getUniverse('sp500');
    const nq = getUniverse('nasdaq100');
    const both = getUniverse('both');
    // Tous les tickers de both ∈ sp ∪ nq
    const setSp = new Set(sp);
    const setNq = new Set(nq);
    for (const t of both) {
      expect(setSp.has(t) || setNq.has(t)).toBe(true);
    }
    // Pas de doublons
    expect(new Set(both).size).toBe(both.length);
  });
});

describe('formatMarkdownReport', () => {
  it('produces markdown with verdict + per-variant breakdown', () => {
    const md = formatMarkdownReport(
      {
        universe: 'sp500',
        start: '2024-01-01',
        end: '2026-01-01',
        cfg: 'default',
      },
      [
        {
          name: 'default',
          cfg: {},
          metrics: {
            total: 5,
            hitRates: { TP1: 0.4, TP2: 0.2, TP3: 0.0, SL: 0.4, TIMEOUT: 0.0 },
            hitCounts: { TP1: 2, TP2: 1, TP3: 0, SL: 2, TIMEOUT: 0 },
            avgPnlPct: 1.5,
            medianPnlPct: 1.0,
            expectancyPct: 1.5,
            totalPnlPct: 7.5,
            maxDrawdownPct: 2,
            sharpeSimple: 0.8,
            winRate: 0.6,
            pnlBuckets: { 'lt_-10pct': 0, '_-10_to_-5pct': 0, '_-5_to_0pct': 2, '_0_to_5pct': 2, '_5_to_10pct': 1, '_10_to_15pct': 0, 'gt_15pct': 0 },
            avgHoldingBars: 4,
          },
          verdict: {
            decision: 'GO',
            reasons: ['all_thresholds_passed'],
            thresholds: { minTp1HitRate: 0.55, minExpectancyPct: 0 },
          },
        },
      ],
      'default',
      30,
      0,
    );
    expect(md).toContain('# Backtest rebound-tp');
    expect(md).toContain('GO');
    expect(md).toContain('default');
    expect(md).toContain('Hit rates');
  });
});
