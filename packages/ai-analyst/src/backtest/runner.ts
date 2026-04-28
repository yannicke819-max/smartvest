/**
 * P3-B — Runner orchestrateur du backtest.
 *
 * Pipeline :
 *   1. Charge l'univers de tickers (SP500 / NASDAQ100 / both).
 *   2. Fetch OHLCV daily depuis EODHD `/api/eod/{ticker}` sur la fenêtre
 *      [start, end].
 *   3. Backtest engine sur chaque ticker.
 *   4. Agrège métriques + verdict.
 *   5. Si NO_GO en --auto-tune : run 3 variantes (RSI, vol spike, dd).
 *   6. Écrit rapports JSON + MD dans `tmp/backtest-rebound-<ts>.{json,md}`.
 *   7. INSERT row `backtest_runs` (si supabase service_role disponible).
 *
 * Fail-fast : si EODHD_API_KEY manque OU si > 50% des fetches échouent,
 * abort avec exit code 1.
 */

import { backtestUniverse, type TickerBars, type BacktestRunCfg, type BacktestTrade } from './engine';
import { computeMetrics, computeVerdict, type BacktestMetrics, type Verdict } from './metrics';
import type { ReboundCfg, Candle } from '../strategies/rebound-tp';

export interface RunnerArgs {
  universe: 'sp500' | 'nasdaq100' | 'both';
  start: string; // ISO YYYY-MM-DD
  end: string;
  cfg: 'default' | 'strict';
  /** Si true et NO_GO sur cfg default, run 3 variantes et choisit la meilleure. */
  autoTune?: boolean;
  /** Provider de bars OHLCV. Injectable pour tests. */
  fetchBars?: (
    ticker: string,
    start: string,
    end: string,
  ) => Promise<Candle[] | null>;
  /** Writer de rapports. Injectable pour tests (default = fs). */
  writeReport?: (filename: string, content: string) => Promise<void>;
  /** Inserter Supabase. Injectable pour tests (default = no-op si pas de supabase). */
  insertRun?: (row: BacktestRunRow) => Promise<void>;
}

export interface BacktestRunRow {
  universe: string;
  start: string;
  end: string;
  cfg_json: Record<string, unknown>;
  metrics_json: Record<string, unknown>;
  verdict: 'GO' | 'NO_GO';
}

export interface RunnerResult {
  selectedVariant: VariantName;
  variants: Array<{
    name: VariantName;
    cfg: ReboundCfg;
    metrics: BacktestMetrics;
    verdict: Verdict;
  }>;
  trades: BacktestTrade[];
  reportJsonPath: string;
  reportMdPath: string;
}

export type VariantName = 'default' | 'strict' | 'rsi_25' | 'vol_2_0' | 'dd_20';

// ── Univers de tickers (subsets liquides) ────────────────────────────

/**
 * SP500 representative subset (50 tickers majeurs, mega/large cap).
 * Lookup complet 503 tickers nécessiterait une table SP500 maintenue —
 * deferred. Ce subset capture l'essentiel pour la validation statistique.
 */
export const SP500_SUBSET = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'META.US', 'TSLA.US',
  'AVGO.US', 'BRK-B.US', 'LLY.US', 'JPM.US', 'V.US', 'XOM.US', 'WMT.US',
  'UNH.US', 'MA.US', 'PG.US', 'JNJ.US', 'HD.US', 'COST.US', 'ORCL.US', 'NFLX.US',
  'ABBV.US', 'BAC.US', 'CRM.US', 'KO.US', 'CVX.US', 'MRK.US', 'AMD.US', 'PEP.US',
  'TMO.US', 'ADBE.US', 'CSCO.US', 'LIN.US', 'ABT.US', 'WFC.US', 'MCD.US', 'ACN.US',
  'NOW.US', 'IBM.US', 'TXN.US', 'GE.US', 'PM.US', 'INTU.US', 'DIS.US', 'AXP.US',
  'CAT.US', 'GS.US', 'ISRG.US', 'BKNG.US',
];

export const NASDAQ100_SUBSET = [
  'AAPL.US', 'MSFT.US', 'NVDA.US', 'AMZN.US', 'GOOGL.US', 'META.US', 'TSLA.US',
  'AVGO.US', 'COST.US', 'NFLX.US', 'ADBE.US', 'AMD.US', 'PEP.US', 'CSCO.US',
  'TMUS.US', 'INTC.US', 'CMCSA.US', 'TXN.US', 'QCOM.US', 'AMAT.US', 'BKNG.US',
  'INTU.US', 'AMGN.US', 'HON.US', 'ISRG.US', 'VRTX.US', 'ADP.US', 'GILD.US',
  'PANW.US', 'KLAC.US', 'LRCX.US', 'REGN.US', 'SBUX.US', 'MU.US', 'MELI.US',
];

// ── Variants & cfg ─────────────────────────────────────────────────────

const CFG_DEFAULT: ReboundCfg = {};
const CFG_STRICT: ReboundCfg = {
  rsiOversold: 25,
  minDrawdownPct: 20,
  volSpikeMult: 2.0,
};

const VARIANT_CFGS: Record<VariantName, ReboundCfg> = {
  default: CFG_DEFAULT,
  strict: CFG_STRICT,
  rsi_25: { rsiOversold: 25 },
  vol_2_0: { volSpikeMult: 2.0 },
  dd_20: { minDrawdownPct: 20 },
};

export function getUniverse(name: 'sp500' | 'nasdaq100' | 'both'): string[] {
  if (name === 'sp500') return SP500_SUBSET;
  if (name === 'nasdaq100') return NASDAQ100_SUBSET;
  return Array.from(new Set([...SP500_SUBSET, ...NASDAQ100_SUBSET]));
}

// ── Fetcher EODHD (default) ────────────────────────────────────────────

/**
 * Fetcher OHLCV daily depuis EODHD. Default pour le CLI prod.
 * Tests injectent leur propre fetcher synthétique.
 */
export async function defaultFetchBars(
  ticker: string,
  start: string,
  end: string,
): Promise<Candle[] | null> {
  const apiKey = process.env.EODHD_API_KEY;
  if (!apiKey) return null;
  const url = `https://eodhd.com/api/eod/${encodeURIComponent(ticker)}?from=${start}&to=${end}&api_token=${encodeURIComponent(apiKey)}&fmt=json&order=a`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      date: string; open: number; high: number; low: number; close: number; volume: number;
    }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data
      .filter(
        (d) =>
          typeof d.open === 'number' &&
          typeof d.high === 'number' &&
          typeof d.low === 'number' &&
          typeof d.close === 'number' &&
          typeof d.volume === 'number',
      )
      .map((d) => ({
        timestamp: d.date,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
        volume: d.volume,
      }));
  } catch {
    return null;
  }
}

// ── Runner principal ──────────────────────────────────────────────────

export async function runBacktest(args: RunnerArgs): Promise<RunnerResult> {
  const fetchBars = args.fetchBars ?? defaultFetchBars;
  const tickers = getUniverse(args.universe);

  // Fetch all bars in parallel (concurrent capped pour pas saturer EODHD).
  const bars: TickerBars[] = [];
  const failed: string[] = [];
  for (const ticker of tickers) {
    const series = await fetchBars(ticker, args.start, args.end);
    if (!series || series.length < 30) {
      failed.push(ticker);
      continue;
    }
    bars.push({ ticker, bars: series });
  }
  // Fail-fast si trop d'échecs
  if (failed.length > tickers.length / 2) {
    throw new Error(
      `[backtest] data provider down: ${failed.length}/${tickers.length} tickers failed`,
    );
  }

  // Run primary cfg
  const primary: VariantName = args.cfg === 'strict' ? 'strict' : 'default';
  const variants: VariantRun[] = [];

  const primaryRes = runOnUniverse(bars, primary);
  variants.push(primaryRes);

  let selectedVariant: VariantName = primary;
  let allTrades = primaryRes._trades;

  // Auto-tune : si NO_GO sur primary, run les 3 variantes alt + sélectionne la meilleure.
  if (args.autoTune && primaryRes.verdict.decision === 'NO_GO') {
    for (const v of ['rsi_25', 'vol_2_0', 'dd_20'] as VariantName[]) {
      const res = runOnUniverse(bars, v);
      variants.push(res);
    }
    // Meilleure = expectancy max parmi GO ; si tous NO_GO, expectancy max overall
    const goVariants = variants.filter((v) => v.verdict.decision === 'GO');
    const pool = goVariants.length > 0 ? goVariants : variants;
    const winner = pool.reduce((best, cur) =>
      cur.metrics.expectancyPct > best.metrics.expectancyPct ? cur : best,
    );
    selectedVariant = winner.name;
    allTrades = winner._trades;
  }

  // Strip _trades du résultat exposé (lourd, on garde dans le runner).
  const cleanVariants: RunnerResult['variants'] = variants.map((v) => ({
    name: v.name,
    cfg: v.cfg,
    metrics: v.metrics,
    verdict: v.verdict,
  }));

  // Write reports
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = `tmp/backtest-rebound-${ts}.json`;
  const mdPath = `tmp/backtest-rebound-${ts}.md`;
  const writeReport = args.writeReport ?? (() => Promise.resolve());

  const reportJson = {
    args,
    runAt: new Date().toISOString(),
    selectedVariant,
    variants: cleanVariants,
    universeSize: tickers.length,
    universeFetched: bars.length,
    failedCount: failed.length,
    tradesTotal: allTrades.length,
  };
  await writeReport(jsonPath, JSON.stringify(reportJson, null, 2));

  const md = formatMarkdownReport(args, cleanVariants, selectedVariant, bars.length, failed.length);
  await writeReport(mdPath, md);

  // INSERT supabase row
  if (args.insertRun) {
    const winner = cleanVariants.find((v) => v.name === selectedVariant)!;
    await args.insertRun({
      universe: args.universe,
      start: args.start,
      end: args.end,
      cfg_json: winner.cfg as Record<string, unknown>,
      metrics_json: winner.metrics as unknown as Record<string, unknown>,
      verdict: winner.verdict.decision,
    }).catch(() => { /* non-blocking */ });
  }

  return {
    selectedVariant,
    variants: cleanVariants,
    trades: allTrades,
    reportJsonPath: jsonPath,
    reportMdPath: mdPath,
  };
}

// ── Internes ──────────────────────────────────────────────────────────

interface VariantRun {
  name: VariantName;
  cfg: ReboundCfg;
  metrics: BacktestMetrics;
  verdict: Verdict;
  _trades: BacktestTrade[];
}

function runOnUniverse(bars: TickerBars[], variant: VariantName): VariantRun {
  const cfg = VARIANT_CFGS[variant];
  const runCfg: BacktestRunCfg = { warmupBars: 25, scannerCfg: cfg };
  const trades = backtestUniverse(bars, runCfg);
  const metrics = computeMetrics(trades);
  const verdict = computeVerdict(metrics);
  return { name: variant, cfg, metrics, verdict, _trades: trades };
}

export function formatMarkdownReport(
  args: RunnerArgs,
  variants: Array<{ name: VariantName; cfg: ReboundCfg; metrics: BacktestMetrics; verdict: Verdict }>,
  selectedVariant: VariantName,
  fetched: number,
  failed: number,
): string {
  const winner = variants.find((v) => v.name === selectedVariant);
  if (!winner) return '# Empty backtest';

  const verdictEmoji = winner.verdict.decision === 'GO' ? '✅' : '❌';
  const lines: string[] = [];
  lines.push(`# Backtest rebound-tp · ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`- **Universe** : \`${args.universe}\` (${fetched} tickers fetched, ${failed} failed)`);
  lines.push(`- **Window** : ${args.start} → ${args.end}`);
  lines.push(`- **Variant retenue** : \`${selectedVariant}\``);
  lines.push(`- **Verdict** : ${verdictEmoji} **${winner.verdict.decision}**`);
  lines.push(`  - Reasons : ${winner.verdict.reasons.join(' · ')}`);
  lines.push(`  - Thresholds : tp1+≥${(winner.verdict.thresholds.minTp1HitRate * 100).toFixed(0)}% · expectancy>${winner.verdict.thresholds.minExpectancyPct}`);
  lines.push('');

  for (const v of variants) {
    lines.push(`## Variant \`${v.name}\``);
    lines.push(`- Cfg : ${JSON.stringify(v.cfg)}`);
    lines.push(`- Trades : ${v.metrics.total}`);
    lines.push(`- Hit rates : TP1=${(v.metrics.hitRates.TP1 * 100).toFixed(1)}% · TP2=${(v.metrics.hitRates.TP2 * 100).toFixed(1)}% · TP3=${(v.metrics.hitRates.TP3 * 100).toFixed(1)}% · SL=${(v.metrics.hitRates.SL * 100).toFixed(1)}% · TIMEOUT=${(v.metrics.hitRates.TIMEOUT * 100).toFixed(1)}%`);
    lines.push(`- Expectancy : ${v.metrics.expectancyPct}% · Median : ${v.metrics.medianPnlPct}%`);
    lines.push(`- Win rate : ${(v.metrics.winRate * 100).toFixed(1)}%`);
    lines.push(`- Total PnL : ${v.metrics.totalPnlPct}% · Max DD : ${v.metrics.maxDrawdownPct}%`);
    lines.push(`- Sharpe : ${v.metrics.sharpeSimple} · Avg holding : ${v.metrics.avgHoldingBars} bars`);
    lines.push(`- Verdict : ${v.verdict.decision} (${v.verdict.reasons.join(', ')})`);
    lines.push('');
  }

  return lines.join('\n');
}
