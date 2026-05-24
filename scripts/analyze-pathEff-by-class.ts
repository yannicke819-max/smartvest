/**
 * Analyse la distribution historique de pathEff par asset_class × decision
 * + PnL simulé pour les rejets path_eff (regret cost).
 *
 * Question : le seuil pathEff = 0.50 est-il calibré pour crypto ou trop strict ?
 *
 * Usage: tsx scripts/analyze-pathEff-by-class.ts [days=30]
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, line) => {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing supabase creds');

const sb = createClient(url, key);

const days = Number(process.argv[2] ?? '30');
const since = new Date(Date.now() - days * 86400_000).toISOString();

type Row = {
  symbol: string;
  asset_class: string;
  path_eff: number | null;
  decision: string;
  cfg_min_path_eff: number | null;
  sim_results: any;
  created_at: string;
};

async function main() {
  // Pagination — table peut être volumineuse
  const rows: Row[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('gainers_user_shadow_signals')
      .select('symbol, asset_class, path_eff, decision, cfg_min_path_eff, sim_results, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
    from += pageSize;
    if (from > 50000) break; // safety
  }

  console.log(`\n=== ${rows.length} rows, last ${days}d ===\n`);

  // Bucket : crypto_* vs others
  const buckets = {
    crypto: rows.filter(r => r.asset_class?.startsWith('crypto')),
    us: rows.filter(r => r.asset_class?.startsWith('us_')),
    eu: rows.filter(r => r.asset_class === 'eu_equity'),
    asia: rows.filter(r => r.asset_class === 'asia_equity'),
  };

  function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return NaN;
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  function summarizePathEff(label: string, subset: Row[]) {
    const withEff = subset.filter(r => r.path_eff != null).map(r => Number(r.path_eff));
    const sorted = [...withEff].sort((a, b) => a - b);
    const accepts = subset.filter(r => r.decision === 'accept');
    const rejectsPathEff = subset.filter(r => r.decision === 'reject_path_eff');
    const accEff = accepts.filter(r => r.path_eff != null).map(r => Number(r.path_eff));
    const rejEff = rejectsPathEff.filter(r => r.path_eff != null).map(r => Number(r.path_eff));

    console.log(`--- ${label} : ${subset.length} signals (${accepts.length} accept, ${rejectsPathEff.length} reject_path_eff) ---`);
    if (sorted.length === 0) { console.log(`  (no path_eff data)\n`); return; }
    console.log(`  Path_eff distribution ALL : p10=${percentile(sorted, 0.1).toFixed(3)} p25=${percentile(sorted, 0.25).toFixed(3)} p50=${percentile(sorted, 0.5).toFixed(3)} p75=${percentile(sorted, 0.75).toFixed(3)} p90=${percentile(sorted, 0.9).toFixed(3)}`);
    if (accEff.length > 0) {
      const accSorted = [...accEff].sort((a, b) => a - b);
      console.log(`  Path_eff distribution ACCEPTED (n=${accEff.length}) : p10=${percentile(accSorted, 0.1).toFixed(3)} p50=${percentile(accSorted, 0.5).toFixed(3)} p90=${percentile(accSorted, 0.9).toFixed(3)}`);
    }
    if (rejEff.length > 0) {
      const rejSorted = [...rejEff].sort((a, b) => a - b);
      console.log(`  Path_eff distribution REJECTED (n=${rejEff.length}) : p10=${percentile(rejSorted, 0.1).toFixed(3)} p50=${percentile(rejSorted, 0.5).toFixed(3)} p90=${percentile(rejSorted, 0.9).toFixed(3)}`);
    }

    // Regret cost : pour les rejets, compute PnL simulé moyen
    const simulatable = rejectsPathEff.filter(r => r.sim_results && typeof r.sim_results === 'object');
    if (simulatable.length > 0) {
      const baseline30 = simulatable
        .map(r => r.sim_results?.baseline_30m)
        .filter(s => s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
      const baseline60 = simulatable
        .map(r => r.sim_results?.baseline_60m)
        .filter(s => s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');

      if (baseline30.length > 0) {
        const winners = baseline30.filter(s => s.pnl_pct > 0).length;
        const mean = baseline30.reduce((a, s) => a + s.pnl_pct, 0) / baseline30.length;
        const tpHits = baseline30.filter(s => s.outcome === 'TP_HIT').length;
        const slHits = baseline30.filter(s => s.outcome === 'SL_HIT').length;
        console.log(`  REGRET baseline_30m (n=${baseline30.length}) : WR=${Math.round(winners*100/baseline30.length)}% mean_pnl=${mean.toFixed(2)}% TP=${tpHits} SL=${slHits} TIME=${baseline30.length-tpHits-slHits}`);
      }
      if (baseline60.length > 0) {
        const winners = baseline60.filter(s => s.pnl_pct > 0).length;
        const mean = baseline60.reduce((a, s) => a + s.pnl_pct, 0) / baseline60.length;
        console.log(`  REGRET baseline_60m (n=${baseline60.length}) : WR=${Math.round(winners*100/baseline60.length)}% mean_pnl=${mean.toFixed(2)}%`);
      }

      // Sliced by pathEff bands : 0.0-0.2 / 0.2-0.3 / 0.3-0.4 / 0.4-0.5
      const bands: Array<[number, number, string]> = [
        [0.0, 0.20, '[0.00-0.20]'],
        [0.20, 0.30, '[0.20-0.30]'],
        [0.30, 0.40, '[0.30-0.40]'],
        [0.40, 0.50, '[0.40-0.50]'],
      ];
      console.log(`  REGRET sliced by path_eff band (baseline_30m) :`);
      for (const [lo, hi, lbl] of bands) {
        const band = simulatable.filter(r => {
          const pe = Number(r.path_eff);
          return pe >= lo && pe < hi;
        });
        const bandSim = band.map(r => r.sim_results?.baseline_30m).filter(s => s && typeof s.pnl_pct === 'number' && s.outcome !== 'NO_DATA');
        if (bandSim.length < 3) { console.log(`    ${lbl} n=${bandSim.length} (too few)`); continue; }
        const winners = bandSim.filter(s => s.pnl_pct > 0).length;
        const mean = bandSim.reduce((a, s) => a + s.pnl_pct, 0) / bandSim.length;
        const tp = bandSim.filter(s => s.outcome === 'TP_HIT').length;
        const sl = bandSim.filter(s => s.outcome === 'SL_HIT').length;
        console.log(`    ${lbl} n=${bandSim.length} WR=${Math.round(winners*100/bandSim.length)}% mean=${mean.toFixed(2)}% TP=${tp} SL=${sl}`);
      }
    } else {
      console.log(`  (no sim_results available — simulator may not have run yet)`);
    }
    console.log();
  }

  for (const [name, subset] of Object.entries(buckets)) {
    summarizePathEff(name, subset);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
