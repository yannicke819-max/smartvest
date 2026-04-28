/**
 * P3-B — CLI entry point pour `npm run backtest:rebound`.
 *
 * Usage :
 *   npm run -w @smartvest/ai-analyst backtest:rebound -- \
 *     --universe=sp500|nasdaq100|both \
 *     --start=2024-04-28 \
 *     --end=2026-04-28 \
 *     --cfg=default|strict \
 *     [--auto-tune]
 *
 * Sortie :
 *   - tmp/backtest-rebound-<ts>.json
 *   - tmp/backtest-rebound-<ts>.md
 *
 * Fail-fast :
 *   - EODHD_API_KEY manquante → exit 1
 *   - > 50% des fetches échouent → exit 1
 *   - args invalides → exit 1
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runBacktest, type RunnerArgs } from '../backtest/runner';
import { createClient } from '@supabase/supabase-js';

interface ParsedArgs {
  universe: 'sp500' | 'nasdaq100' | 'both';
  start: string;
  end: string;
  cfg: 'default' | 'strict';
  autoTune: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const get = (key: string): string | undefined => {
    const arg = argv.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.split('=').slice(1).join('=') : undefined;
  };
  const has = (flag: string): boolean => argv.includes(`--${flag}`);

  const universe = (get('universe') ?? 'both') as ParsedArgs['universe'];
  if (!['sp500', 'nasdaq100', 'both'].includes(universe)) {
    throw new Error(`Invalid --universe (got "${universe}"). Must be sp500|nasdaq100|both`);
  }
  const cfg = (get('cfg') ?? 'default') as ParsedArgs['cfg'];
  if (!['default', 'strict'].includes(cfg)) {
    throw new Error(`Invalid --cfg (got "${cfg}"). Must be default|strict`);
  }
  const start = get('start') ?? new Date(Date.now() - 730 * 86_400_000).toISOString().slice(0, 10);
  const end = get('end') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error(`Invalid --start: ${start}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error(`Invalid --end: ${end}`);

  return { universe, start, end, cfg, autoTune: has('auto-tune') };
}

async function main(): Promise<void> {
  if (!process.env.EODHD_API_KEY) {
    console.error('[backtest] EODHD_API_KEY missing — set it in env before running.');
    process.exit(1);
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[backtest] ${(e as Error).message}`);
    process.exit(1);
  }

  console.log(`[backtest] universe=${parsed.universe} start=${parsed.start} end=${parsed.end} cfg=${parsed.cfg} autoTune=${parsed.autoTune}`);

  // Ensure tmp/ dir exists
  await fs.mkdir('tmp', { recursive: true });

  const args: RunnerArgs = {
    universe: parsed.universe,
    start: parsed.start,
    end: parsed.end,
    cfg: parsed.cfg,
    autoTune: parsed.autoTune,
    writeReport: async (filename: string, content: string) => {
      const fp = path.resolve(filename);
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, content, 'utf-8');
      console.log(`[backtest] wrote ${fp}`);
    },
    insertRun: async (row) => {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        console.warn('[backtest] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing — skip DB insert');
        return;
      }
      const sb = createClient(url, key);
      const { error } = await sb.from('backtest_runs').insert(row);
      if (error) console.warn(`[backtest] backtest_runs insert failed: ${error.message}`);
      else console.log('[backtest] backtest_runs row inserted');
    },
  };

  try {
    const result = await runBacktest(args);
    const winner = result.variants.find((v) => v.name === result.selectedVariant);
    console.log(`[backtest] ✓ done · variant=${result.selectedVariant} · verdict=${winner?.verdict.decision}`);
    console.log(`[backtest]   reports: ${result.reportJsonPath} ; ${result.reportMdPath}`);
    process.exit(0);
  } catch (e) {
    console.error(`[backtest] FAILED: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
