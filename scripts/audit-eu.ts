import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const now = new Date();
const since2h = new Date(Date.now() - 2 * 3600_000).toISOString();
const since1h = new Date(Date.now() - 1 * 3600_000).toISOString();
const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();

async function main() {
  console.log(`\n=== AUDIT EU — ${now.toISOString().slice(0,19)} UTC (${now.getUTCHours()+2}:${String(now.getUTCMinutes()).padStart(2,'0')} CEST) ===\n`);

  // 1. Shadow signals EU 6h
  console.log('─── 1. SHADOW SIGNALS EU (6h) ───');
  const { data: shadow6h } = await sb.from('gainers_v1_shadow_signals')
    .select('exchange, decision, created_at, symbol')
    .gte('created_at', since6h)
    .or('exchange.eq.PA,exchange.eq.XETRA,exchange.eq.DE,exchange.eq.L,exchange.eq.LSE,exchange.eq.AS,exchange.eq.MI,exchange.eq.SW,exchange.eq.MC,exchange.eq.F')
    .order('created_at', { ascending: false })
    .limit(100);
  console.log(`  Total EU signaux 6h : ${shadow6h?.length ?? 0}`);
  if (shadow6h && shadow6h.length > 0) {
    const byEx: Record<string, Record<string, number>> = {};
    for (const s of shadow6h as any[]) {
      const ex = s.exchange ?? '?';
      if (!byEx[ex]) byEx[ex] = {};
      byEx[ex][s.decision] = (byEx[ex][s.decision] ?? 0) + 1;
    }
    for (const [ex, dec] of Object.entries(byEx)) {
      console.log(`    ${ex.padEnd(8)} ${JSON.stringify(dec)}`);
    }
  } else {
    console.log('  ⚠️  AUCUN signal EU 6h — pipeline EU non scanné');
  }

  // 2. Screener EODHD EU calls 2h
  console.log('\n─── 2. SCREENER EODHD EU (2h) ───');
  const { data: screener } = await sb.from('eodhd_request_log')
    .select('ticker, success, http_status, timestamp')
    .gte('timestamp', since2h)
    .or('ticker.eq.gainers_screener_PA,ticker.eq.gainers_screener_XETRA,ticker.eq.gainers_screener_DE,ticker.eq.gainers_screener_LSE,ticker.eq.gainers_screener_L,ticker.eq.gainers_screener_AS,ticker.eq.gainers_screener_MI,ticker.eq.gainers_screener_SW,ticker.eq.gainers_screener_MC,ticker.eq.gainers_screener_F')
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`  Appels screener EU 2h : ${screener?.length ?? 0}`);
  if (screener && screener.length > 0) {
    const byEx: Record<string, {ok:number;fail:number}> = {};
    for (const c of screener as any[]) {
      const ex = c.ticker.replace('gainers_screener_', '');
      if (!byEx[ex]) byEx[ex] = {ok:0,fail:0};
      if (c.success) byEx[ex].ok++; else byEx[ex].fail++;
    }
    for (const [ex, s] of Object.entries(byEx)) {
      console.log(`  ${ex.padEnd(8)} ok=${s.ok} fail=${s.fail}`);
    }
  } else {
    console.log('  ⚠️  AUCUN appel screener EU 2h');
  }

  // 3. Toutes les watchlists EU disponibles
  console.log('\n─── 3. WATCHLISTS EU EN DB ───');
  const { data: wl } = await sb.from('watchlist_universe')
    .select('name, exchange, session_open_utc, session_close_utc')
    .or('exchange.eq.PA,exchange.eq.XETRA,exchange.eq.DE,exchange.eq.LSE,exchange.eq.L,exchange.eq.AS,exchange.eq.MI,exchange.eq.SW,exchange.eq.MC,exchange.eq.F');
  if (wl && wl.length > 0) {
    const byName: Record<string,{ex:string;open:string;close:string;count:number}> = {};
    for (const w of wl as any[]) {
      if (!byName[w.name]) byName[w.name] = {ex:w.exchange, open:w.session_open_utc, close:w.session_close_utc, count:0};
      byName[w.name].count++;
    }
    for (const [name, w] of Object.entries(byName)) {
      console.log(`  ${name.padEnd(20)} ex=${w.ex.padEnd(6)} session=${w.open}-${w.close} count=${w.count}`);
    }
  } else {
    console.log('  ⚠️  Aucune watchlist EU en DB');
  }

  // 4. Dernier signal EU TOUS TEMPS
  console.log('\n─── 4. DERNIER SIGNAL PAR EXCHANGE EU ───');
  for (const ex of ['PA', 'XETRA', 'DE', 'LSE', 'L', 'AS', 'MI', 'SW']) {
    const { data } = await sb.from('gainers_v1_shadow_signals')
      .select('created_at, decision, symbol')
      .eq('exchange', ex)
      .order('created_at', { ascending: false }).limit(1);
    const last = (data as any[])?.[0];
    if (last) {
      const ageH = Math.round((Date.now() - new Date(last.created_at).getTime()) / 3_600_000);
      console.log(`  ${ex.padEnd(6)} dernier : ${last.created_at.slice(0,19)} (il y a ${ageH}h) ${last.symbol} → ${last.decision}`);
    } else {
      console.log(`  ${ex.padEnd(6)} AUCUN signal jamais`);
    }
  }

  // 5. Positions EU ouvertes / fermées récentes
  console.log('\n─── 5. POSITIONS EU (24h) ───');
  const since24h = new Date(Date.now() - 24*3600_000).toISOString();
  const { data: pos } = await sb.from('lisa_positions')
    .select('symbol, status, direction, entry_timestamp, closed_at')
    .gte('entry_timestamp', since24h)
    .or('symbol.like.%.PA,symbol.like.%.XETRA,symbol.like.%.DE,symbol.like.%.L,symbol.like.%.LSE,symbol.like.%.AS,symbol.like.%.MI,symbol.like.%.SW')
    .order('entry_timestamp', { ascending: false })
    .limit(10);
  console.log(`  Positions EU 24h : ${pos?.length ?? 0}`);
  for (const p of (pos ?? []) as any[]) {
    console.log(`    ${p.entry_timestamp.slice(11,19)} ${p.symbol.padEnd(15)} ${p.direction} ${p.status}`);
  }

  // 6. Decision log gainers 1h
  console.log('\n─── 6. DECISION LOG GAINERS (1h) ───');
  const { data: dl } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at')
    .gte('created_at', since1h)
    .or('kind.like.gainers_%,kind.like.%scanner%')
    .order('created_at', { ascending: false })
    .limit(20);
  const kinds: Record<string,number> = {};
  for (const d of (dl ?? []) as any[]) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  console.log('  Counts 1h:', JSON.stringify(kinds));

  // 7. Positions OUVERTES en ce moment
  console.log('\n─── 7. POSITIONS OUVERTES MAINTENANT ───');
  const { data: openPos } = await sb.from('lisa_positions')
    .select('symbol, direction, status, entry_timestamp, entry_notional_usd')
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: false });
  console.log(`  Total open : ${openPos?.length ?? 0}`);
  for (const p of (openPos ?? []) as any[]) {
    const ageMin = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60_000);
    console.log(`    ${p.entry_timestamp.slice(11,19)} ${p.symbol.padEnd(15)} ${p.direction.padEnd(5)} $${p.entry_notional_usd} (il y a ${ageMin}min)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
