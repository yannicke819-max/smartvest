/**
 * Analyse de la table `oversold_scan_rejections` (mission "gate qui rate les pépites").
 *
 * Le scan intraday loggue désormais CHAQUE candidat avec le gate exact qui l'a
 * rejeté + les métriques. Ce script exploite ce corpus pour répondre à LA
 * question : quel gate étrangle le pipeline, et le fait-il à raison ?
 *
 *   1. Répartition des rejets par stage (no_candles / insufficient_bars /
 *      analysis_null / rebound_filter) + ouvertures.
 *   2. Pour rebound_filter : QUEL sous-gate bloque (rebound% / trend15m /
 *      bottom-timing / volRatio), en distinguant "apparaît" (≥1 fois dans les
 *      raisons) vs "SEUL bloqueur" (la raison unique = le vrai goulot).
 *   3. Near-miss : combien de candidats étaient JUSTE sous le seuil (≥70% du
 *      seuil) → récupérables en relâchant légèrement.
 *   4. Regret forward : combien de rejets ont rebondi ≥1,5% depuis le creux
 *      (close_j) jusqu'au prix live actuel (proxy EODHD real-time).
 *
 * Usage : npx tsx scripts/analyze-oversold-scan-rejections.ts [--days 7]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const EODHD = process.env.EODHD_API_KEY!;

// Seuils par défaut (cf. DEFAULT_INTRADAY_REBOUND_CONFIG). Override si tu changes la config Fly.
const TH = { rebound: 1.5, trend15m: 0.3, volRatio: 0.8, bottomBars: 2 };

interface Row {
  symbol: string;
  scanned_at: string;
  scan_phase: string;
  region: string | null;
  drop_pct: number | null;
  close_j: number | null;
  outcome: string;
  reject_stage: string | null;
  reject_reasons: string[] | null;
  rebound_pct: number | null;
  trend_15m_pct: number | null;
  volume_ratio: number | null;
  bottom_bar_idx: number | null;
  bars_count: number | null;
}

/** Classe une chaîne de raison en label de gate. */
function gateOf(reason: string): 'rebound' | 'trend15m' | 'bottom_timing' | 'volume_ratio' | 'autre' {
  if (reason.startsWith('rebound=')) return 'rebound';
  if (reason.startsWith('trend15m=')) return 'trend15m';
  if (reason.startsWith('bottom ')) return 'bottom_timing';
  if (reason.startsWith('volRatio=')) return 'volume_ratio';
  return 'autre';
}

async function realtimeBulk(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let k = 0; k < symbols.length; k += 20) {
    const chunk = symbols.slice(k, k + 20);
    const [first, ...rest] = chunk;
    const s = rest.length ? `&s=${rest.join(',')}` : '';
    const url = `https://eodhd.com/api/real-time/${encodeURIComponent(first)}?api_token=${EODHD}&fmt=json${s}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      let j = await r.json();
      if (!Array.isArray(j)) j = [j];
      for (const q of j as Array<{ code?: string; close?: number }>) {
        if (q.code && Number.isFinite(Number(q.close))) out.set(q.code, Number(q.close));
      }
    } catch { /* skip */ }
  }
  return out;
}

function bar(n: number, max: number, width = 30): string {
  const f = max > 0 ? Math.round((n / max) * width) : 0;
  return '█'.repeat(f) + '·'.repeat(width - f);
}

async function main() {
  const daysArg = process.argv.indexOf('--days');
  const days = daysArg >= 0 ? Number(process.argv[daysArg + 1]) : 7;
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const { data, error } = await sb
    .from('oversold_scan_rejections')
    .select('symbol, scanned_at, scan_phase, region, drop_pct, close_j, outcome, reject_stage, reject_reasons, rebound_pct, trend_15m_pct, volume_ratio, bottom_bar_idx, bars_count')
    .gte('scanned_at', since)
    .order('scanned_at', { ascending: false });
  if (error) { console.error('ERR', error.message); process.exit(1); }
  const rows = (data ?? []) as Row[];

  console.log(`\n🔬 ANALYSE oversold_scan_rejections — ${days}j (depuis ${since.slice(0, 10)})`);
  console.log(`   ${rows.length} candidat-scans loggés\n`);
  if (rows.length === 0) {
    console.log('⚠️ Table vide. Elle se peuple au prochain scan intraday sur Fly (post-deploy).');
    console.log('   Cron intraday : 0 0 8-20 * * 1-5 UTC (horaire, séances EU+US).');
    return;
  }

  // 1. Répartition par stage
  const byStage = new Map<string, number>();
  for (const r of rows) {
    const k = r.outcome === 'opened' ? '✅ opened' : (r.reject_stage ?? 'rejected(?)');
    byStage.set(k, (byStage.get(k) ?? 0) + 1);
  }
  console.log('─'.repeat(64));
  console.log('1) RÉPARTITION PAR STAGE');
  console.log('─'.repeat(64));
  const maxStage = Math.max(...byStage.values());
  for (const [k, n] of [...byStage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${bar(n, maxStage)} ${n}`);
  }

  // 2. Sous-gate pour rebound_filter : apparaît vs SEUL bloqueur
  const rf = rows.filter((r) => r.reject_stage === 'rebound_filter' && Array.isArray(r.reject_reasons));
  const appears = new Map<string, number>();
  const sole = new Map<string, number>();
  for (const r of rf) {
    const gates = (r.reject_reasons ?? []).map(gateOf);
    const uniq = [...new Set(gates)];
    for (const g of uniq) appears.set(g, (appears.get(g) ?? 0) + 1);
    if (uniq.length === 1) sole.set(uniq[0], (sole.get(uniq[0]) ?? 0) + 1);
  }
  console.log('\n' + '─'.repeat(64));
  console.log(`2) SOUS-GATE rebound_filter (${rf.length} rejets) — apparaît vs SEUL bloqueur`);
  console.log('─'.repeat(64));
  console.log(`  ${'gate'.padEnd(16)} ${'apparaît'.padEnd(10)} ${'SEUL'.padEnd(8)} (seul = vrai goulot)`);
  const allGates = new Set([...appears.keys(), ...sole.keys()]);
  for (const g of [...allGates].sort((a, b) => (appears.get(b) ?? 0) - (appears.get(a) ?? 0))) {
    const a = appears.get(g) ?? 0;
    const s = sole.get(g) ?? 0;
    const flag = s / Math.max(1, rf.length) > 0.3 ? '  🔴 SUSPECT' : '';
    console.log(`  ${g.padEnd(16)} ${String(a).padEnd(10)} ${String(s).padEnd(8)}${flag}`);
  }

  // 3. Near-miss : juste sous le seuil (≥70% du seuil) sur le gate dominant
  console.log('\n' + '─'.repeat(64));
  console.log('3) NEAR-MISS (juste sous le seuil → récupérables)');
  console.log('─'.repeat(64));
  const nmRebound = rf.filter((r) => r.rebound_pct != null && r.rebound_pct >= TH.rebound * 0.7 && r.rebound_pct < TH.rebound).length;
  const nmTrend = rf.filter((r) => r.trend_15m_pct != null && r.trend_15m_pct >= TH.trend15m * 0.5 && r.trend_15m_pct < TH.trend15m).length;
  const nmVol = rf.filter((r) => r.volume_ratio != null && r.volume_ratio >= TH.volRatio * 0.85 && r.volume_ratio < TH.volRatio).length;
  console.log(`  rebound ∈ [${(TH.rebound * 0.7).toFixed(2)}%, ${TH.rebound}%)  : ${nmRebound} candidats (seuil rebound=${TH.rebound}%)`);
  console.log(`  trend15m ∈ [${(TH.trend15m * 0.5).toFixed(2)}%, ${TH.trend15m}%) : ${nmTrend} candidats (seuil trend15m=${TH.trend15m}%)`);
  console.log(`  volRatio ∈ [${(TH.volRatio * 0.85).toFixed(2)}, ${TH.volRatio})   : ${nmVol} candidats (seuil volRatio=${TH.volRatio})`);

  // 4. Regret forward : rejets qui ont rebondi ≥1,5% depuis close_j
  console.log('\n' + '─'.repeat(64));
  console.log('4) REGRET FORWARD (rejet → rebond ≥1,5% depuis le creux close_j ?)');
  console.log('─'.repeat(64));
  // Dernier rejet par symbole (close_j de référence le plus récent)
  const lastRej = new Map<string, Row>();
  for (const r of rows) {
    if (r.outcome !== 'rejected' || r.close_j == null) continue;
    if (!lastRej.has(r.symbol)) lastRej.set(r.symbol, r); // rows sont déjà desc → 1er = plus récent
  }
  const syms = [...lastRej.keys()];
  if (syms.length === 0) {
    console.log('  (aucun rejet avec close_j → rien à mesurer)');
  } else {
    const live = await realtimeBulk(syms);
    let measured = 0, regret = 0;
    const lines: string[] = [];
    for (const [sym, r] of lastRej) {
      const cur = live.get(sym);
      if (cur == null || r.close_j == null) continue;
      measured++;
      const reb = ((cur - r.close_j) / r.close_j) * 100;
      const isRegret = reb >= 1.5;
      if (isRegret) regret++;
      const gate = (r.reject_reasons ?? []).map(gateOf).join(',') || r.reject_stage;
      lines.push(`  ${sym.padEnd(13)} close_j=${String(r.close_j).padEnd(9)} live=${String(cur).padEnd(9)} reb=${reb >= 0 ? '+' : ''}${reb.toFixed(2)}%  ${isRegret ? '🔴' : reb >= 0.5 ? '🟡' : '🟢'} [${gate}]`);
    }
    lines.sort();
    for (const l of lines) console.log(l);
    const pct = measured ? (regret / measured) * 100 : 0;
    console.log(`\n  VERDICT : ${regret}/${measured} rejets ont rebondi ≥1,5% (${pct.toFixed(0)}% de regret).`);
    console.log(pct > 30
      ? '  ⚠️ > 30% → le filtre intraday rate de vrais rebonds → relâcher le gate SEUL-bloqueur dominant (cf. §2).'
      : '  ✅ < 30% → le filtre rejette majoritairement à raison.');
  }
  console.log('');
}

main().catch((e) => { console.error('failed:', e); process.exit(1); });
