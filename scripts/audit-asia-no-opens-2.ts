/**
 * Audit phase 2 : pourquoi le scanner Asia ne génère aucun candidat ?
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
const since6h = new Date(Date.now() - 6 * 60 * 60_000).toISOString();
const since24h = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

async function main() {
  const nowUtc = new Date();
  console.log(`\n=== AUDIT ASIA PHASE 2 — ${nowUtc.toISOString().slice(0, 19)} UTC ===\n`);

  // 1. Le scanner tourne-t-il ? → decision_log all kinds 1h
  console.log('─── 1. SCANNER ACTIF ? decision_log toutes catégories 1h ───');
  const { data: all1h, count: count1h } = await sb
    .from('lisa_decision_log')
    .select('kind, created_at', { count: 'exact' })
    .gte('created_at', since1h)
    .order('created_at', { ascending: false })
    .limit(200);
  console.log(`  Total decision_log 1h : ${count1h ?? 0}`);
  if (all1h && all1h.length > 0) {
    const byKind: Record<string, number> = {};
    for (const d of all1h as any[]) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    const sorted = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    for (const [k, c] of sorted) console.log(`    ${String(c).padStart(4)}  ${k}`);
  }

  // 2. Shadow signals TOUTES bourses 1h (pas juste Asia)
  console.log('\n─── 2. SHADOW SIGNALS TOUTES BOURSES (1h) ───');
  const { data: shadowAll, count: shadowAllCount } = await sb
    .from('gainers_v1_shadow_signals')
    .select('exchange, decision, created_at', { count: 'exact' })
    .gte('created_at', since1h)
    .order('created_at', { ascending: false })
    .limit(100);
  console.log(`  Total shadow signals 1h : ${shadowAllCount ?? 0}`);
  if (shadowAll && shadowAll.length > 0) {
    const byExchange: Record<string, number> = {};
    for (const s of shadowAll as any[]) {
      const key = `${s.exchange ?? '?'}/${s.decision}`;
      byExchange[key] = (byExchange[key] ?? 0) + 1;
    }
    for (const [k, c] of Object.entries(byExchange).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${k}`);
    }
  }

  // 3. EODHD calls TOUTES bourses 1h
  console.log('\n─── 3. EODHD CALLS TOUTES BOURSES (1h) ───');
  const { count: eodTotal } = await sb
    .from('eodhd_request_log')
    .select('*', { count: 'exact', head: true })
    .gte('timestamp', since1h);
  console.log(`  Total appels EODHD 1h : ${eodTotal ?? 0}`);

  const { data: eodByCaller } = await sb
    .from('eodhd_request_log')
    .select('called_by, success')
    .gte('timestamp', since1h)
    .limit(2000);
  if (eodByCaller && eodByCaller.length > 0) {
    const map: Record<string, number> = {};
    for (const r of eodByCaller as any[]) {
      map[r.called_by ?? '?'] = (map[r.called_by ?? '?'] ?? 0) + 1;
    }
    for (const [k, c] of Object.entries(map).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(c).padStart(4)}  ${k}`);
    }
  }

  // 4. Shadow signals Asia sur 24h (y a-t-il eu des signaux avant ?)
  console.log('\n─── 4. SHADOW SIGNALS ASIA (24h) ───');
  const { data: shadowAsia24, count: shadowAsia24Count } = await sb
    .from('gainers_v1_shadow_signals')
    .select('exchange, decision, created_at', { count: 'exact' })
    .gte('created_at', since24h)
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.HK,exchange.eq.T,exchange.eq.SHG,exchange.eq.SHE')
    .order('created_at', { ascending: false })
    .limit(50);
  console.log(`  Signaux shadow Asia 24h : ${shadowAsia24Count ?? 0}`);
  if (shadowAsia24 && shadowAsia24.length > 0) {
    const last = (shadowAsia24 as any[])[0];
    console.log(`  Dernier signal Asia : ${last.created_at.slice(0, 19)} [${last.exchange}] ${last.decision}`);
    // Répartition par exchange
    const byEx: Record<string, number> = {};
    for (const s of shadowAsia24 as any[]) byEx[s.exchange ?? '?'] = (byEx[s.exchange ?? '?'] ?? 0) + 1;
    console.log(`  Par exchange : ${JSON.stringify(byEx)}`);
  } else {
    console.log('  ⚠️  AUCUN signal Asia sur 24h — problème de fond (config marché, watchlist, ou scanner off)');
  }

  // 5. Watchlist Asia en DB
  console.log('\n─── 5. WATCHLIST ASIA EN DB ───');
  const { data: wl, error: wlErr } = await sb
    .from('watchlist_universe')
    .select('name, exchange, ticker_count:tickers')
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.HK,exchange.eq.T,exchange.eq.SHG,exchange.eq.SHE,name.like.%asia%,name.like.%korea%,name.like.%japan%');
  if (wlErr) {
    console.log(`  Erreur watchlist_universe : ${wlErr.message}`);
  } else {
    console.log(`  Watchlists Asia trouvées : ${wl?.length ?? 0}`);
    for (const w of (wl ?? []) as any[]) {
      const n = Array.isArray(w.ticker_count) ? w.ticker_count.length : '?';
      console.log(`    name=${w.name} exchange=${w.exchange} tickers=${n}`);
    }
  }

  // 6. Dernières sessions autopilot (LisaAutopilot) — est-il actif ?
  console.log('\n─── 6. AUTOPILOT CYCLES RÉCENTS (1h) ───');
  const { data: autopilot } = await sb
    .from('lisa_decision_log')
    .select('kind, summary, created_at, payload')
    .gte('created_at', since1h)
    .in('kind', ['autopilot_cycle_completed', 'autopilot_cycle_skipped', 'autopilot_paused', 'gainers_scan_started', 'gainers_scan_completed', 'gainers_open', 'gainers_skip'])
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`  Entrées autopilot/gainers 1h : ${autopilot?.length ?? 0}`);
  for (const a of (autopilot ?? []) as any[]) {
    console.log(`    ${a.created_at.slice(11, 19)} [${a.kind}] ${(a.summary ?? '').slice(0, 100)}`);
  }

  // 7. Positions récemment ouvertes toutes bourses 6h
  console.log('\n─── 7. POSITIONS OUVERTES TOUTES BOURSES (6h) ───');
  const { data: posAll } = await sb
    .from('lisa_positions')
    .select('symbol, direction, entry_timestamp, status')
    .gte('entry_timestamp', since6h)
    .order('entry_timestamp', { ascending: false })
    .limit(10);
  console.log(`  Total positions 6h : ${posAll?.length ?? 0}`);
  for (const p of (posAll ?? []) as any[]) {
    console.log(`    ${p.entry_timestamp.slice(11, 19)} ${p.symbol.padEnd(15)} ${p.direction} ${p.status}`);
  }

  console.log('\n=== FIN AUDIT PHASE 2 ===\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
