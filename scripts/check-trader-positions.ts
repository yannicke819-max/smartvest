import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();

  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, direction, entry_price, exit_price, size_usd, pnl_usd, status, opened_at, closed_at')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('opened_at', since)
    .order('opened_at', { ascending: false });

  console.log(`\n═══ TRADER positions ouvertes ${since.slice(0,16)} → now ═══`);
  console.log(`Total : ${positions?.length ?? 0}\n`);
  if (positions?.length) {
    let pnl = 0;
    let wins = 0, losses = 0, open = 0;
    for (const p of positions) {
      const pnlVal = Number(p.pnl_usd ?? 0);
      pnl += pnlVal;
      if (p.status === 'open' || p.status === 'active') open++;
      else if (pnlVal > 0) wins++;
      else losses++;
      console.log(`  ${p.symbol.padEnd(12)} ${p.asset_class.padEnd(20)} ${p.direction.padEnd(5)} entry=$${Number(p.entry_price ?? 0).toFixed(2).padStart(8)} status=${p.status.padEnd(20)} pnl=$${pnlVal.toFixed(2).padStart(8)} opened=${p.opened_at.slice(11,16)} closed=${p.closed_at?.slice(11,16) ?? '—'}`);
    }
    console.log(`\nTotal PnL: $${pnl.toFixed(2)}, Wins: ${wins}, Losses: ${losses}, Open: ${open}`);
  } else {
    console.log('  ⚠ Aucune position ouverte par TRADER ces 24h.');
  }

  console.log(`\n═══ Last 5 TRADER autopilot_cycle_completed events ═══`);
  const { data: cycles } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .eq('kind', 'autopilot_cycle_completed')
    .order('timestamp', { ascending: false })
    .limit(5);
  for (const c of cycles ?? []) {
    const p = c.payload as any;
    console.log(`  ${c.timestamp.slice(11,19)} opens=${p?.opens ?? 0} closes=${p?.closes ?? 0} candidates=${p?.candidates_count ?? '?'}`);
  }

  console.log(`\n═══ Shadow signals last 6h (post-secret-set) ═══`);
  const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class, decision')
    .gte('created_at', since6h);
  const breakdown = new Map<string, Map<string, number>>();
  for (const s of shadow ?? []) {
    if (!breakdown.has(s.asset_class)) breakdown.set(s.asset_class, new Map());
    const m = breakdown.get(s.asset_class)!;
    m.set(s.decision, (m.get(s.decision) ?? 0) + 1);
  }
  for (const [cls, m] of breakdown) {
    const total = [...m.values()].reduce((s,n) => s+n, 0);
    const accept = m.get('accept') ?? 0;
    const top3 = [...m].filter(([k]) => k !== 'accept').sort((a,b) => b[1]-a[1]).slice(0,3);
    console.log(`  ${cls.padEnd(22)} total=${total.toString().padStart(4)} accept=${accept.toString().padStart(3)} (${((accept/total)*100).toFixed(0).padStart(3)}%) top: ${top3.map(([k,v]) => `${k}:${v}`).join(', ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
