/**
 * Audit Asia v2 — shadow signals + screener + persistence, toutes décisions
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
const since3d = new Date(Date.now() - 3 * 86_400_000).toISOString();
const since1h = new Date(Date.now() - 1 * 3600_000).toISOString();

async function main() {
  const now = new Date();
  console.log(`\n=== AUDIT ASIA V2 — ${now.toISOString().slice(0, 19)} UTC ===\n`);

  // 1. Shadow signals Asia TOUTES DÉCISIONS (3j)
  console.log('─── 1. SHADOW SIGNALS ASIA TOUTES DÉCISIONS (3j) ───');
  const { data: shadowAll } = await sb.from('gainers_v1_shadow_signals')
    .select('decision, exchange, created_at')
    .gte('created_at', since3d)
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.SHG,exchange.eq.SHE,exchange.eq.HK,exchange.eq.T')
    .order('created_at', { ascending: false })
    .limit(200);
  console.log(`  Total signaux Asia 3j : ${shadowAll?.length ?? 0}`);
  if (shadowAll && shadowAll.length > 0) {
    const byDecEx: Record<string, number> = {};
    for (const s of shadowAll as any[]) {
      const k = `${s.exchange}/${s.decision}`;
      byDecEx[k] = (byDecEx[k] ?? 0) + 1;
    }
    for (const [k, n] of Object.entries(byDecEx).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${String(n).padStart(5)}  ${k}`);
    }
    const last = (shadowAll as any[])[0];
    const ageH = Math.round((Date.now() - new Date(last.created_at).getTime()) / 3_600_000);
    console.log(`  Dernier signal Asia : ${last.created_at.slice(0, 19)} [${last.exchange}] ${last.decision} (il y a ${ageH}h)`);
  } else {
    console.log('  ⚠️  AUCUN signal Asia 3j — le screener n\'est pas en train de scanner ou ne retourne rien');
  }

  // 2. Screener EODHD calls Asia (6h)
  console.log('\n─── 2. SCREENER EODHD ASIA (6h) ───');
  const { data: screenerCalls } = await sb.from('eodhd_request_log')
    .select('ticker, success, http_status, timestamp')
    .gte('timestamp', since6h)
    .or('ticker.eq.gainers_screener_KO,ticker.eq.gainers_screener_KQ,ticker.eq.gainers_screener_SHG,ticker.eq.gainers_screener_SHE,ticker.eq.gainers_screener_HK,ticker.eq.gainers_screener_T')
    .order('timestamp', { ascending: false })
    .limit(30);
  const screenerByEx: Record<string, { ok: number; fail: number; last: string }> = {};
  for (const c of (screenerCalls ?? []) as any[]) {
    const ex = c.ticker.replace('gainers_screener_', '');
    if (!screenerByEx[ex]) screenerByEx[ex] = { ok: 0, fail: 0, last: '' };
    if (c.success) screenerByEx[ex].ok++; else screenerByEx[ex].fail++;
    if (!screenerByEx[ex].last) screenerByEx[ex].last = c.timestamp.slice(11, 19);
  }
  if (Object.keys(screenerByEx).length === 0) {
    console.log('  ⚠️  Aucun appel screener Asia 6h → scanner muet pour ces exchanges');
  }
  for (const [ex, s] of Object.entries(screenerByEx)) {
    console.log(`  ${ex.padEnd(6)} ok=${s.ok} fail=${s.fail} last=${s.last}`);
  }

  // 3. Scanner cycle — decision_log scan_started/completed (6h)
  console.log('\n─── 3. SCANNER CYCLES (6h) ───');
  const { data: cycles } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at')
    .gte('created_at', since6h)
    .in('kind', ['gainers_scan_started', 'gainers_scan_completed', 'gainers_open', 'gainers_skip'])
    .order('created_at', { ascending: false })
    .limit(20);
  const cycleCounts: Record<string, number> = {};
  for (const c of (cycles ?? []) as any[]) cycleCounts[c.kind] = (cycleCounts[c.kind] ?? 0) + 1;
  console.log('  Counts 6h :', JSON.stringify(cycleCounts));
  // Derniers 5 scan_completed pour voir le résumé
  const completed = (cycles ?? []).filter((c: any) => c.kind === 'gainers_scan_completed');
  for (const c of (completed as any[]).slice(0, 5)) {
    console.log(`    ${c.created_at?.slice(11, 19)} ${c.summary?.slice(0, 120)}`);
  }

  // 4. Shadow signals TOUTES BOURSES 1h (pour voir si le scanner tourne)
  console.log('\n─── 4. SHADOW SIGNALS TOUTES BOURSES (1h) ───');
  const { data: shadowAllEx } = await sb.from('gainers_v1_shadow_signals')
    .select('exchange, decision')
    .gte('created_at', since1h)
    .limit(1000);
  const byEx: Record<string, Record<string, number>> = {};
  for (const s of (shadowAllEx ?? []) as any[]) {
    const ex = s.exchange ?? '?';
    if (!byEx[ex]) byEx[ex] = {};
    byEx[ex][s.decision] = (byEx[ex][s.decision] ?? 0) + 1;
  }
  if (Object.keys(byEx).length === 0) {
    console.log('  ⚠️  Aucun signal shadow 1h — scanner arrêté ou sérieusement bloqué');
  }
  for (const [ex, dec] of Object.entries(byEx).sort((a, b) => {
    const ta = Object.values(a[1]).reduce((x, y) => x + y, 0);
    const tb = Object.values(b[1]).reduce((x, y) => x + y, 0);
    return (tb as number) - (ta as number);
  })) {
    console.log(`    ${ex.padEnd(6)} ${JSON.stringify(dec)}`);
  }

  // 5. isMarketOpen Asia — heure actuelle
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcMinTotal = utcHour * 60 + utcMin;
  const asiaOpenMin = 0;
  const asiaCloseMin = 8 * 60; // 8:00 UTC
  const asiaOpen = utcMinTotal >= asiaOpenMin && utcMinTotal < asiaCloseMin;
  console.log(`\n─── 5. ÉTAT SESSIONS ───`);
  console.log(`  UTC actuel : ${now.toISOString().slice(11, 16)}`);
  console.log(`  asiaOpen (isMarketOpen global, 00h-08h UTC) : ${asiaOpen}`);
  console.log(`  KO/KQ closeUTC : 06:30 → ${utcMinTotal < 6 * 60 + 30 ? 'OUVERT' : 'FERMÉ'}`);
  console.log(`  SHG/SHE closeUTC : 07:00 → ${utcMinTotal < 7 * 60 ? 'OUVERT' : 'FERMÉ'}`);
  console.log(`  HK closeUTC : 08:00 → ${utcMinTotal < 8 * 60 ? 'OUVERT' : 'FERMÉ'}`);

  // 6. La config portfolio — universe asia + session filter
  console.log('\n─── 6. CONFIG PORTFOLIO GAINERS ───');
  const { data: cfg } = await sb.from('lisa_session_configs')
    .select('gainers_universe_asia, gainers_session_filter_enabled, gainers_universe_us, gainers_universe_eu, gainers_universe_crypto, strategy_mode, autopilot_enabled, autopilot_paused_reason, capital_usd, gainers_min_persistence_score, gainers_asia_strictness_boost')
    .eq('strategy_mode', 'gainers')
    .limit(1);
  const c = (cfg as any[])?.[0];
  if (c) {
    console.log(`  strategy_mode               = ${c.strategy_mode}`);
    console.log(`  autopilot_enabled           = ${c.autopilot_enabled}`);
    console.log(`  autopilot_paused_reason     = ${c.autopilot_paused_reason ?? 'null'}`);
    console.log(`  gainers_universe_asia       = ${c.gainers_universe_asia}`);
    console.log(`  gainers_session_filter_enabled = ${c.gainers_session_filter_enabled}`);
    console.log(`  gainers_universe_us         = ${c.gainers_universe_us}`);
    console.log(`  gainers_universe_eu         = ${c.gainers_universe_eu}`);
    console.log(`  gainers_universe_crypto     = ${c.gainers_universe_crypto}`);
    console.log(`  capital_usd                 = ${c.capital_usd}`);
    console.log(`  gainers_min_persistence_score = ${c.gainers_min_persistence_score}`);
    console.log(`  gainers_asia_strictness_boost = ${c.gainers_asia_strictness_boost}`);
  } else {
    console.log('  ⚠️  Aucune config gainers trouvée');
  }

  console.log('\n=== FIN AUDIT ASIA V2 ===\n');
}
main().catch(e => { console.error(e); process.exit(1); });
