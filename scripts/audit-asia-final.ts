import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const nowUtc = new Date();
  console.log(`\n=== AUDIT FINAL — ${nowUtc.toISOString().slice(0,19)} UTC ===\n`);

  // 1. Dernier signal Asia par exchange (heure exacte)
  console.log('─── 1. DERNIER SIGNAL PAR EXCHANGE ASIA ───');
  for (const ex of ['KO', 'KQ', 'SHG', 'SHE', 'HK', 'T']) {
    const { data } = await sb.from('gainers_v1_shadow_signals')
      .select('created_at, decision').eq('exchange', ex)
      .order('created_at', { ascending: false }).limit(1);
    const last = (data as any[])?.[0];
    if (last) {
      const ageMin = Math.round((Date.now() - new Date(last.created_at).getTime()) / 60_000);
      console.log(`  ${ex.padEnd(4)} dernier signal : ${last.created_at.slice(11,19)} UTC (il y a ${ageMin} min) — ${last.decision}`);
    } else {
      console.log(`  ${ex.padEnd(4)} AUCUN signal en DB`);
    }
  }

  // 2. Exchanges des signaux créés dans les 5 dernières minutes
  const since5m = new Date(Date.now() - 5 * 60_000).toISOString();
  console.log('\n─── 2. EXCHANGES DES SIGNAUX (5 dernières min) ───');
  const { data: recent5m } = await sb.from('gainers_v1_shadow_signals')
    .select('exchange, decision').gte('created_at', since5m).limit(1000);
  const byEx5m: Record<string, Record<string, number>> = {};
  for (const s of (recent5m ?? []) as any[]) {
    const ex = s.exchange ?? '?';
    if (!byEx5m[ex]) byEx5m[ex] = {};
    byEx5m[ex][s.decision] = (byEx5m[ex][s.decision] ?? 0) + 1;
  }
  if (Object.keys(byEx5m).length === 0) {
    console.log('  (aucun signal dans les 5 dernières minutes)');
  }
  for (const [ex, dec] of Object.entries(byEx5m)) {
    console.log(`  ${ex.padEnd(6)} ${JSON.stringify(dec)}`);
  }

  // 3. Heure de rupture : quand Asia a-t-il arrêté ?
  console.log('\n─── 3. CHRONOLOGIE RUPTURE ASIA (signaux par tranche 15min, 4h) ───');
  const since4h = new Date(Date.now() - 4 * 3600_000).toISOString();
  const { data: timeline } = await sb.from('gainers_v1_shadow_signals')
    .select('created_at, exchange')
    .gte('created_at', since4h)
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.SHG,exchange.eq.SHE,exchange.eq.HK,exchange.eq.T')
    .order('created_at', { ascending: false })
    .limit(500);
  // Grouper par tranche 15min
  const bySlot: Record<string, number> = {};
  for (const s of (timeline ?? []) as any[]) {
    const d = new Date(s.created_at);
    const slot = `${d.toISOString().slice(11,14)}${Math.floor(d.getUTCMinutes()/15)*15}`.padEnd(5, '0');
    bySlot[slot] = (bySlot[slot] ?? 0) + 1;
  }
  const slots = Object.entries(bySlot).sort((a,b) => b[0].localeCompare(a[0]));
  if (slots.length === 0) {
    console.log('  ⚠️  Aucun signal Asia dans les 4 dernières heures !');
  } else {
    for (const [slot, n] of slots) {
      const hh = parseInt(slot.slice(0,2));
      const mm = parseInt(slot.slice(2));
      console.log(`  ${String(hh).padStart(2,'0')}h${String(mm).padStart(2,'0')} UTC : ${n} signaux`);
    }
  }

  // 4. Est-ce que le screener EODHD retourne des résultats pour KO/SHG/HK ?
  // → regarder si des positions ont déjà été ouvertes et sur quel exchange elles le sont
  console.log('\n─── 4. DERNIÈRES POSITIONS ASIA TOUTES DATES ───');
  const { data: lastAsPos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, realized_pnl_usd')
    .or('symbol.like.%.KO,symbol.like.%.KQ,symbol.like.%.HK,symbol.like.%.T,symbol.like.%.SHG,symbol.like.%.SHE')
    .order('entry_timestamp', { ascending: false }).limit(5);
  if (!lastAsPos || lastAsPos.length === 0) {
    console.log('  ⚠️  Aucune position Asia jamais ouverte en DB !');
  } else {
    for (const p of lastAsPos as any[]) {
      const age = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60_000);
      console.log(`  ${p.entry_timestamp.slice(0,19)} ${p.symbol.padEnd(15)} ${p.status} pnl=${p.realized_pnl_usd ?? '?'} (il y a ${age}min)`);
    }
  }

  // 5. Signaux ACCEPT Asia depuis quand → dernières ouvertures shadow
  console.log('\n─── 5. DERNIERS ACCEPT ASIA (shadow) ───');
  const { data: lastAccept } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, created_at, path_efficiency, persistence_score')
    .eq('decision', 'ACCEPT')
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.SHG,exchange.eq.SHE,exchange.eq.HK,exchange.eq.T')
    .order('created_at', { ascending: false }).limit(5);
  for (const s of (lastAccept ?? []) as any[]) {
    const ageMin = Math.round((Date.now() - new Date(s.created_at).getTime()) / 60_000);
    console.log(`  ${s.created_at.slice(11,19)} ${s.symbol.padEnd(15)} [${s.exchange}] eff=${s.path_efficiency} persist=${s.persistence_score} (il y a ${ageMin}min)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
