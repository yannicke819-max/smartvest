import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since14d = new Date(Date.now() - 14 * 24 * 3600e3).toISOString();

  // ============ FEATURE 1 : Path eff par classe (gainers_user_shadow_signals) ============
  console.log('═══ FEATURE 1 — PATH EFF par classe (14j) ═══');
  const { data: signals } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, path_eff, persistence_score, decision, change_pct_1m, cfg_min_path_eff, sim_results, is_asia, created_at')
    .gte('created_at', since14d)
    .not('path_eff', 'is', null);

  if (signals && signals.length > 0) {
    const byClass: Record<string, { n: number; b1: number; b2: number; b3: number; b4: number; accept: number; rejPath: number; rejOther: number; sumPE: number; simWins: number; simN: number; simTP: number; simSL: number }> = {};
    for (const s of signals) {
      const cls = s.asset_class || 'unknown';
      if (!byClass[cls]) byClass[cls] = { n: 0, b1: 0, b2: 0, b3: 0, b4: 0, accept: 0, rejPath: 0, rejOther: 0, sumPE: 0, simWins: 0, simN: 0, simTP: 0, simSL: 0 };
      byClass[cls].n++;
      const pe = s.path_eff || 0;
      byClass[cls].sumPE += pe;
      if (pe < 0.20) byClass[cls].b1++;
      else if (pe < 0.40) byClass[cls].b2++;
      else if (pe < 0.60) byClass[cls].b3++;
      else byClass[cls].b4++;
      const dec = String(s.decision || '');
      if (dec === 'accept') byClass[cls].accept++;
      else if (dec.toLowerCase().includes('path')) byClass[cls].rejPath++;
      else byClass[cls].rejOther++;
      // sim_results outcome
      const sim = s.sim_results as any;
      if (sim && typeof sim === 'object') {
        const outcome = String(sim.outcome ?? '').toLowerCase();
        byClass[cls].simN++;
        if (outcome === 'tp_hit') { byClass[cls].simWins++; byClass[cls].simTP++; }
        else if (outcome === 'sl_hit') byClass[cls].simSL++;
      }
    }
    console.log(`Total = ${signals.length}\n`);
    console.log('Classe          | n    | <0.20 | <0.40 | <0.60 | ≥0.60 | accept | rej_path | rej_other | avg PE | sim_n | TP | SL | sim_winRate');
    console.log('----------------|------|-------|-------|-------|-------|--------|----------|-----------|--------|-------|----|----|------------');
    for (const [cls, b] of Object.entries(byClass).sort((a,b) => b[1].n - a[1].n)) {
      const avg = (b.sumPE / b.n).toFixed(2);
      const wr = b.simN > 0 ? `${((b.simWins / b.simN) * 100).toFixed(0)}%` : '—';
      console.log(`${cls.padEnd(15)} | ${b.n.toString().padStart(4)} | ${b.b1.toString().padStart(5)} | ${b.b2.toString().padStart(5)} | ${b.b3.toString().padStart(5)} | ${b.b4.toString().padStart(5)} | ${b.accept.toString().padStart(6)} | ${b.rejPath.toString().padStart(8)} | ${b.rejOther.toString().padStart(9)} | ${avg.padStart(6)} | ${b.simN.toString().padStart(5)} | ${b.simTP.toString().padStart(2)} | ${b.simSL.toString().padStart(2)} | ${wr.padStart(10)}`);
    }
  }

  // ============ FEATURE 1.5 : Path eff bucket vs sim outcome (toutes classes) ============
  console.log('\n═══ FEATURE 1.5 — PATH EFF bucket vs sim outcome (toutes classes 14j) ═══');
  const buckets = [
    { name: '0.00-0.20', lo: 0, hi: 0.20 },
    { name: '0.20-0.30', lo: 0.20, hi: 0.30 },
    { name: '0.30-0.40', lo: 0.30, hi: 0.40 },
    { name: '0.40-0.50', lo: 0.40, hi: 0.50 },
    { name: '0.50-0.60', lo: 0.50, hi: 0.60 },
    { name: '0.60-0.80', lo: 0.60, hi: 0.80 },
    { name: '0.80-1.00', lo: 0.80, hi: 1.01 },
  ];
  const stats: Record<string, { n: number; tp: number; sl: number; timeout: number; sumPnl: number; nPnl: number }> = {};
  for (const b of buckets) stats[b.name] = { n: 0, tp: 0, sl: 0, timeout: 0, sumPnl: 0, nPnl: 0 };
  for (const s of signals ?? []) {
    const pe = s.path_eff || 0;
    const sim = s.sim_results as any;
    if (!sim) continue;
    const bucket = buckets.find(b => pe >= b.lo && pe < b.hi);
    if (!bucket) continue;
    stats[bucket.name].n++;
    const outcome = String(sim.outcome ?? '').toLowerCase();
    if (outcome === 'tp_hit') stats[bucket.name].tp++;
    else if (outcome === 'sl_hit') stats[bucket.name].sl++;
    else if (outcome.includes('timeout') || outcome.includes('expired')) stats[bucket.name].timeout++;
    if (typeof sim.pnl_pct === 'number') { stats[bucket.name].sumPnl += sim.pnl_pct; stats[bucket.name].nPnl++; }
  }
  console.log('Bucket    | n   | TP  | SL  | timeout | winRate | avg PnL%');
  console.log('----------|-----|-----|-----|---------|---------|--------');
  for (const [k, b] of Object.entries(stats)) {
    const wr = b.n > 0 ? `${((b.tp / b.n) * 100).toFixed(0)}%` : '—';
    const avg = b.nPnl > 0 ? `${(b.sumPnl / b.nPnl).toFixed(2)}%` : '—';
    console.log(`${k.padEnd(9)} | ${b.n.toString().padStart(3)} | ${b.tp.toString().padStart(3)} | ${b.sl.toString().padStart(3)} | ${b.timeout.toString().padStart(7)} | ${wr.padStart(7)} | ${avg.padStart(7)}`);
  }

  // ============ FEATURE 2 : Persistence bucket vs sim outcome ============
  console.log('\n═══ FEATURE 2 — PERSISTENCE SCORE vs sim outcome (14j) ═══');
  const pBuckets = [
    { name: '0.00 (0/6)', lo: -0.01, hi: 0.05 },
    { name: '0.17-0.33 (1-2/6)', lo: 0.05, hi: 0.45 },
    { name: '0.50 (3/6)', lo: 0.45, hi: 0.55 },
    { name: '0.67-0.83 (4-5/6)', lo: 0.55, hi: 0.95 },
    { name: '1.00 (6/6)', lo: 0.95, hi: 1.01 },
  ];
  const pStats: Record<string, { n: number; tp: number; sl: number; timeout: number; sumPnl: number; nPnl: number }> = {};
  for (const b of pBuckets) pStats[b.name] = { n: 0, tp: 0, sl: 0, timeout: 0, sumPnl: 0, nPnl: 0 };
  for (const s of signals ?? []) {
    const ps = s.persistence_score;
    if (ps == null) continue;
    const sim = s.sim_results as any;
    if (!sim) continue;
    const bucket = pBuckets.find(b => ps >= b.lo && ps < b.hi);
    if (!bucket) continue;
    pStats[bucket.name].n++;
    const outcome = String(sim.outcome ?? '').toLowerCase();
    if (outcome === 'tp_hit') pStats[bucket.name].tp++;
    else if (outcome === 'sl_hit') pStats[bucket.name].sl++;
    else if (outcome.includes('timeout') || outcome.includes('expired')) pStats[bucket.name].timeout++;
    if (typeof sim.pnl_pct === 'number') { pStats[bucket.name].sumPnl += sim.pnl_pct; pStats[bucket.name].nPnl++; }
  }
  console.log('Bucket              | n   | TP  | SL  | timeout | winRate | avg PnL%');
  console.log('--------------------|-----|-----|-----|---------|---------|--------');
  for (const [k, b] of Object.entries(pStats)) {
    const wr = b.n > 0 ? `${((b.tp / b.n) * 100).toFixed(0)}%` : '—';
    const avg = b.nPnl > 0 ? `${(b.sumPnl / b.nPnl).toFixed(2)}%` : '—';
    console.log(`${k.padEnd(19)} | ${b.n.toString().padStart(3)} | ${b.tp.toString().padStart(3)} | ${b.sl.toString().padStart(3)} | ${b.timeout.toString().padStart(7)} | ${wr.padStart(7)} | ${avg.padStart(7)}`);
  }

  // Cross-tab : path_eff × persistence
  console.log('\n═══ CROSS — path_eff × persistence_score → winRate ═══');
  const peLevels = [
    { name: '<0.30', lo: 0, hi: 0.30 },
    { name: '0.30-0.50', lo: 0.30, hi: 0.50 },
    { name: '≥0.50', lo: 0.50, hi: 1.01 },
  ];
  const psLevels = [
    { name: '<0.34', lo: 0, hi: 0.34 },
    { name: '0.34-0.67', lo: 0.34, hi: 0.67 },
    { name: '≥0.67', lo: 0.67, hi: 1.01 },
  ];
  console.log('              ' + psLevels.map(p => p.name.padStart(15)).join(''));
  for (const pe of peLevels) {
    let line = `pe ${pe.name.padEnd(10)}`;
    for (const ps of psLevels) {
      const filtered = (signals ?? []).filter(s => {
        if (s.path_eff == null || s.persistence_score == null) return false;
        if (!(s.path_eff >= pe.lo && s.path_eff < pe.hi)) return false;
        if (!(s.persistence_score >= ps.lo && s.persistence_score < ps.hi)) return false;
        return !!s.sim_results;
      });
      const tp = filtered.filter(s => String((s.sim_results as any)?.outcome ?? '').toLowerCase() === 'tp_hit').length;
      const wr = filtered.length > 0 ? `${((tp / filtered.length) * 100).toFixed(0)}%` : '—';
      line += ` ${filtered.length}/${wr}`.padStart(15);
    }
    console.log(line);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
