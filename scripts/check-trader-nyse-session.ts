import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';

  // Window 1: NYSE session hier (2026-06-04 14:30-21:00 UTC)
  const nyseFrom = '2026-06-04T14:30:00.000Z';
  const nyseTo = '2026-06-04T21:00:00.000Z';
  console.log(`\n═══ Window NYSE 2026-06-04 14:30 → 21:00 UTC ═══\n`);

  // Shadow signals during NYSE session
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision')
    .gte('created_at', nyseFrom)
    .lt('created_at', nyseTo);
  const breakdown = new Map<string, Map<string, number>>();
  for (const s of shadow ?? []) {
    if (!breakdown.has(s.asset_class)) breakdown.set(s.asset_class, new Map());
    const m = breakdown.get(s.asset_class)!;
    m.set(s.decision, (m.get(s.decision) ?? 0) + 1);
  }
  console.log(`Shadow signals NYSE session (${shadow?.length ?? 0} total):`);
  for (const [cls, m] of breakdown) {
    const total = [...m.values()].reduce((s,n) => s+n, 0);
    const accept = m.get('accept') ?? 0;
    const top3 = [...m].filter(([k]) => k !== 'accept').sort((a,b) => b[1]-a[1]).slice(0,3);
    console.log(`  ${cls.padEnd(22)} total=${total.toString().padStart(4)} accept=${accept.toString().padStart(3)} (${((accept/total)*100).toFixed(0).padStart(3)}%) top: ${top3.map(([k,v]) => `${k}:${v}`).join(', ')}`);
  }

  // TRADER positions opened during NYSE
  console.log(`\nTRADER positions ouvertes pendant NYSE :`);
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, entry_price, status, pnl_usd, opened_at')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('opened_at', nyseFrom)
    .lt('opened_at', nyseTo);
  console.log(`  Total: ${positions?.length ?? 0}`);
  for (const p of positions ?? []) {
    console.log(`    ${p.symbol.padEnd(12)} ${p.asset_class.padEnd(20)} status=${p.status} pnl=$${Number(p.pnl_usd ?? 0).toFixed(2)} opened=${p.opened_at.slice(11,16)}`);
  }

  // TRADER autopilot_cycle_completed during NYSE
  console.log(`\nTRADER autopilot_cycle_completed pendant NYSE :`);
  const { data: cycles } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'autopilot_cycle_completed')
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo)
    .order('timestamp', { ascending: false });
  console.log(`  Total: ${cycles?.length ?? 0}`);
  let totalOpens = 0, totalCloses = 0;
  for (const c of cycles ?? []) {
    const p = c.payload as any;
    totalOpens += p?.opens ?? 0;
    totalCloses += p?.closes ?? 0;
  }
  console.log(`  Sum opens: ${totalOpens}, Sum closes: ${totalCloses}`);

  // Sample payloads
  if (cycles?.length) {
    console.log(`\nSample payloads (premier + dernier) :`);
    console.log('  First:', JSON.stringify(cycles[cycles.length-1].payload).slice(0, 200));
    console.log('  Last :', JSON.stringify(cycles[0].payload).slice(0, 200));
  }

  // Other relevant kinds during NYSE
  console.log(`\nTop 10 decision_log kinds pendant NYSE (TRADER) :`);
  const { data: allKinds } = await sb
    .from('lisa_decision_log')
    .select('kind')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('timestamp', nyseFrom)
    .lt('timestamp', nyseTo);
  const kindCounts = new Map<string, number>();
  for (const k of allKinds ?? []) {
    kindCounts.set(k.kind, (kindCounts.get(k.kind) ?? 0) + 1);
  }
  const sortedKinds = [...kindCounts].sort((a,b) => b[1]-a[1]).slice(0, 15);
  for (const [k, v] of sortedKinds) {
    console.log(`  ${k.padEnd(40)} ${v}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
