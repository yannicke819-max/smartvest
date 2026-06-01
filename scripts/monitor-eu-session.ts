import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TD = '1304e11cb4f648b196e9b6b2182705ab';
const PID = 'b0000001-0000-0000-0000-000000000001';
const EU_PROBES = ['CAC:EURONEXT', 'DAX:XETR', 'UKX:LSE', 'BMW:XETR', 'AIR:EURONEXT', 'BARC:LSE', 'SIE:XETR'];

async function snapshot() {
  const now = new Date().toISOString().slice(11, 19);
  console.log(`\n=== ${now} UTC ===`);

  // 1. TD live probe (control: EU index)
  const tdRows: string[] = [];
  for (const sym of EU_PROBES) {
    try {
      const r = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(sym)}&apikey=${TD}`);
      const j: any = await r.json();
      if (j.code) { tdRows.push(`  ${sym.padEnd(18)} ERROR ${j.message?.slice(0,40)}`); continue; }
      const tsSec = j.timestamp ? Number(j.timestamp) : 0;
      const ageSec = tsSec ? Math.floor(Date.now() / 1000 - tsSec) : -1;
      const ageStr = ageSec < 60 ? `${ageSec}s` : ageSec < 3600 ? `${(ageSec/60).toFixed(1)}m` : `${(ageSec/3600).toFixed(1)}h`;
      tdRows.push(`  ${sym.padEnd(18)} close=${String(j.close).padStart(10)} age=${ageStr.padStart(6)} open=${j.is_market_open}`);
    } catch (e: any) { tdRows.push(`  ${sym}: ${e.message}`); }
  }
  console.log('TD live:');
  tdRows.forEach(l => console.log(l));

  // 2. Recent decision_log last 90s
  const since = new Date(Date.now() - 90 * 1000).toISOString();
  const { data: log } = await sb.from('lisa_decision_log')
    .select('kind, summary, created_at, payload')
    .eq('portfolio_id', PID)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  const kinds: Record<string, number> = {};
  if (log) for (const e of log as any[]) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  console.log(`\nDecision_log last 90s (${log?.length ?? 0} events):`);
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n}`);

  // 3. EU-flagged events specifically
  const euEvents = (log ?? []).filter((e: any) => {
    const s = (e.summary ?? '') + JSON.stringify(e.payload ?? {});
    return /\.PA|\.DE|\.LSE|\.SW|\.AS|\.MI|\.XETR|\.MC|eu_equity|EU_EQ/i.test(s);
  });
  if (euEvents.length) {
    console.log(`\nEU-specific events (${euEvents.length}):`);
    for (const e of euEvents.slice(0, 10) as any[]) {
      console.log(`  ${e.created_at.slice(11,19)} ${e.kind.padEnd(36)} ${e.summary?.slice(0,80) ?? ''}`);
    }
  }

  // 4. State: open positions
  const { data: open } = await sb.from('lisa_positions')
    .select('symbol, direction, asset_class, entry_price, entry_notional_usd, entry_timestamp')
    .eq('portfolio_id', PID).eq('status', 'open');
  console.log(`\nOPEN positions: ${open?.length ?? 0}`);
  if (open) for (const p of open as any[]) {
    const ageMin = Math.floor((Date.now() - new Date(p.entry_timestamp).getTime()) / 60000);
    console.log(`  ${p.symbol.padEnd(12)} ${p.direction.padEnd(6)} ${(p.asset_class ?? '?').padEnd(20)} entry=${p.entry_price} notional=$${p.entry_notional_usd} age=${ageMin}min`);
  }
}

(async () => {
  console.log(`Monitor EU session — interval 30s, Ctrl+C to stop`);
  for (let i = 0; i < 24; i++) { // 12 minutes max
    await snapshot();
    await new Promise(r => setTimeout(r, 30000));
  }
})();
