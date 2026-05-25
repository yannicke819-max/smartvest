import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  // Positions ouvertes
  const { count: openCount } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('status', 'open');
  console.log('Positions OPEN actuelles:', openCount);

  // Positions fermées ces 30 dernières min
  const since30min = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: closed30, count: closedCount } = await sb.from('lisa_positions')
    .select('symbol, status, exit_reason, exit_timestamp, realized_pnl_usd, realized_pnl_pct', { count: 'exact' })
    .neq('status', 'open')
    .gte('exit_timestamp', since30min)
    .order('exit_timestamp', { ascending: false })
    .limit(50);
  console.log('Positions FERMÉES depuis 30min:', closedCount);
  if (closed30 && closed30.length > 0) {
    let pnlTotal = 0;
    for (const p of closed30 as any[]) {
      const pnl = Number(p.realized_pnl_usd ?? 0);
      pnlTotal += pnl;
      console.log(`  ${p.exit_timestamp.slice(11,19)} ${p.symbol.padEnd(15)} ${p.status.padEnd(20)} pnl=$${pnl.toFixed(2).padStart(8)} reason=${p.exit_reason ?? '?'}`);
    }
    console.log(`  PnL TOTAL closes 30min: $${pnlTotal.toFixed(2)}`);
  }

  // Decision log recents
  const sinceRecent = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: recent } = await sb.from('lisa_decision_log')
    .select('kind, timestamp, summary')
    .gte('timestamp', sinceRecent)
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`\nDecision_log 15 dernières min (${recent?.length ?? 0}):`);
  for (const r of (recent ?? []) as any[]) {
    console.log(`  ${r.timestamp.slice(11,19)} ${r.kind.padEnd(35)} ${(r.summary ?? '').slice(0, 80)}`);
  }
})();
