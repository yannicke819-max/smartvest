/**
 * Cherche la valeur effective de GAINERS_OPEN_BUFFER_MIN en analysant
 * les minsSinceOpen vs reject_opening_buffer dans les logs (déduit le seuil).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();

// Exchange open times UTC (été / BST)
const EXCH_OPEN_UTC: Record<string, number> = {
  LSE: 7 * 60,    // 07:00 UTC (BST = UTC+1, open 08:00 local → 07:00 UTC en été)
  PA: 7 * 60,
  AS: 7 * 60,
  XETRA: 7 * 60,
  DE: 7 * 60,
  SW: 7 * 60,
  TO: 14 * 60 + 30,  // Toronto 14:30 UTC
  US: 14 * 60 + 30,
  SHG: 1 * 60 + 30,
  SHE: 1 * 60 + 30,
  T: 0,
  HK: 1 * 60 + 30,
  NSE: 3 * 60 + 45,
};

async function main() {
  const { data, error } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, created_at')
    .gte('created_at', since)
    .eq('decision', 'reject_opening_buffer')
    .order('created_at', { ascending: false })
    .limit(5000);

  if (error || !data) { console.error(error); return; }

  console.log(`\n=== minsSinceOpen distribution pour ${data.length} reject_opening_buffer 7d ===\n`);

  const minsSinceOpen: number[] = [];
  const byExchange: Record<string, number[]> = {};

  for (const r of data) {
    const sym = String(r.symbol ?? '');
    const m = sym.match(/\.([A-Z]+)$/);
    const ex = m ? m[1] : null;
    if (!ex || EXCH_OPEN_UTC[ex] === undefined) continue;
    const t = new Date(r.created_at);
    const nowMin = t.getUTCHours() * 60 + t.getUTCMinutes();
    const delta = nowMin - EXCH_OPEN_UTC[ex];
    if (delta < 0 || delta > 240) continue;
    minsSinceOpen.push(delta);
    if (!byExchange[ex]) byExchange[ex] = [];
    byExchange[ex].push(delta);
  }

  minsSinceOpen.sort((a, b) => a - b);
  if (minsSinceOpen.length === 0) { console.log('Aucun match exchange'); return; }
  console.log(`min: ${minsSinceOpen[0]} | p25: ${minsSinceOpen[Math.floor(minsSinceOpen.length*0.25)]} | med: ${minsSinceOpen[Math.floor(minsSinceOpen.length/2)]} | p75: ${minsSinceOpen[Math.floor(minsSinceOpen.length*0.75)]} | p95: ${minsSinceOpen[Math.floor(minsSinceOpen.length*0.95)]} | max: ${minsSinceOpen[minsSinceOpen.length-1]}`);
  console.log(`\n→ Le seuil GAINERS_OPEN_BUFFER_MIN ≈ p95 = ${minsSinceOpen[Math.floor(minsSinceOpen.length*0.95)]} min (les rejets s'arrêtent au-delà)\n`);

  console.log('Par exchange :');
  for (const [ex, vals] of Object.entries(byExchange)) {
    vals.sort((a, b) => a - b);
    const p95 = vals[Math.floor(vals.length*0.95)];
    const max = vals[vals.length-1];
    console.log(`  .${ex.padEnd(8)} n=${String(vals.length).padStart(3)}  max minsSinceOpen=${max} (p95=${p95})`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
