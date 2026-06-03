/**
 * Audit reject_opening_buffer sur les 7 derniers jours.
 *
 * Question : le gate GAINERS_OPEN_BUFFER_MIN tue-t-il des pépites ?
 * Méthode : pour chaque reject_opening_buffer, simuler outcome 60min via
 * EODHD intraday 5m candles, compter TP_HIT (+3%) vs SL_HIT (-1.5%).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

async function main() {
  console.log(`\n=== AUDIT reject_opening_buffer — last 7d (since ${since.slice(0,16)}) ===\n`);

  const { data, error } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at, change_pct_1m, score, path_eff')
    .gte('created_at', since)
    .eq('decision', 'reject_opening_buffer')
    .order('created_at', { ascending: false })
    .limit(10000);

  if (error) { console.error(error); process.exit(1); }
  if (!data || data.length === 0) { console.log('Aucun reject_opening_buffer 7d.'); return; }

  console.log(`Total reject_opening_buffer 7d : ${data.length}\n`);

  // Breakdown par asset_class
  const byClass: Record<string, number> = {};
  for (const r of data) byClass[r.asset_class ?? '?'] = (byClass[r.asset_class ?? '?'] ?? 0) + 1;
  console.log('Par asset_class :');
  for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`);
  }

  // Breakdown par suffix (exchange)
  const bySuffix: Record<string, number> = {};
  for (const r of data) {
    const sym = String(r.symbol ?? '');
    const m = sym.match(/\.([A-Z]+)$/);
    const suffix = m ? m[1] : 'NONE';
    bySuffix[suffix] = (bySuffix[suffix] ?? 0) + 1;
  }
  console.log('\nPar suffix :');
  for (const [k, v] of Object.entries(bySuffix).sort((a, b) => b[1] - a[1])) {
    console.log(`  .${k.padEnd(10)} ${v}`);
  }

  // Breakdown par heure UTC
  const byHour: Record<number, number> = {};
  for (const r of data) {
    const h = new Date(r.created_at).getUTCHours();
    byHour[h] = (byHour[h] ?? 0) + 1;
  }
  console.log('\nPar heure UTC :');
  for (let h = 0; h < 24; h++) {
    if (byHour[h]) console.log(`  ${String(h).padStart(2, '0')}h : ${byHour[h]}`);
  }

  // changePct distribution
  const changes = data.map(r => Number(r.change_pct_1m ?? 0)).filter(Number.isFinite).sort((a, b) => a - b);
  if (changes.length > 0) {
    const med = changes[Math.floor(changes.length / 2)];
    const p25 = changes[Math.floor(changes.length * 0.25)];
    const p75 = changes[Math.floor(changes.length * 0.75)];
    const max = changes[changes.length - 1];
    console.log(`\nchangePct distrib : p25=${p25.toFixed(2)}% med=${med.toFixed(2)}% p75=${p75.toFixed(2)}% max=${max.toFixed(2)}%`);
  }

  // Sample top 20 par changePct
  const sorted = [...data].sort((a, b) => Number(b.change_pct_1m ?? 0) - Number(a.change_pct_1m ?? 0));
  console.log('\nTop 20 par changePct (potentielles pépites loupées) :');
  console.log('  symbol           class          change   score  path  created_at');
  for (const r of sorted.slice(0, 20)) {
    console.log(`  ${String(r.symbol).padEnd(16)} ${String(r.asset_class).padEnd(14)} ${String(Number(r.change_pct_1m ?? 0).toFixed(2)).padStart(6)}%  ${String(Number(r.score ?? 0).toFixed(2)).padStart(5)}  ${String(Number(r.path_eff ?? 0).toFixed(2)).padStart(4)}  ${r.created_at.slice(0,16)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
