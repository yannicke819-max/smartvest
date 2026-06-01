import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

const PIDS: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'MAIN',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
};

const todayStart = new Date();
todayStart.setUTCHours(0, 0, 0, 0);

(async () => {
  console.log(`\n========== RÉSULTATS 5 SCANNERS — ${new Date().toISOString()} ==========`);
  console.log(`(jour UTC depuis ${todayStart.toISOString().slice(0, 10)} 00:00)\n`);

  const grand = { open: 0, closed: 0, wins: 0, losses: 0, realized: 0, deployed: 0 };

  for (const [pid, name] of Object.entries(PIDS)) {
    // CLOSED today
    const { data: closed } = await sb
      .from('lisa_positions')
      .select('symbol, direction, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, exit_timestamp, entry_notional_usd')
      .eq('portfolio_id', pid)
      .neq('status', 'open')
      .gte('exit_timestamp', todayStart.toISOString())
      .order('exit_timestamp', { ascending: true });

    // OPEN now
    const { data: open } = await sb
      .from('lisa_positions')
      .select('symbol, direction, entry_price, entry_notional_usd, entry_timestamp')
      .eq('portfolio_id', pid)
      .eq('status', 'open');

    const c = closed ?? [];
    const o = open ?? [];
    const realized = c.reduce((s, p) => s + Number(p.realized_pnl_usd ?? 0), 0);
    const wins = c.filter((p) => Number(p.realized_pnl_usd ?? 0) > 0).length;
    const losses = c.filter((p) => Number(p.realized_pnl_usd ?? 0) < 0).length;
    const deployed = o.reduce((s, p) => s + Number(p.entry_notional_usd ?? 0), 0);
    const wr = c.length > 0 ? ((wins / c.length) * 100).toFixed(0) : '—';

    grand.open += o.length;
    grand.closed += c.length;
    grand.wins += wins;
    grand.losses += losses;
    grand.realized += realized;
    grand.deployed += deployed;

    console.log(`\n${'━'.repeat(70)}`);
    console.log(`${name.padEnd(8)} (${pid.slice(0, 8)})  —  réalisé ${realized >= 0 ? '+' : ''}$${realized.toFixed(2)} · ${c.length} closes (W${wins}/L${losses}, WR ${wr}%) · ${o.length} open ($${deployed.toFixed(0)} déployé)`);

    if (c.length > 0) {
      console.log(`  CLOSES :`);
      for (const p of c) {
        const pnl = Number(p.realized_pnl_usd ?? 0);
        const pct = p.realized_pnl_pct != null ? Number(p.realized_pnl_pct).toFixed(1) : '?';
        const ts = p.exit_timestamp ? String(p.exit_timestamp).slice(11, 16) : '??';
        const flag = pnl >= 0 ? '🟢' : '🔴';
        console.log(`    ${flag} ${ts} ${String(p.symbol).padEnd(13)} ${String(p.direction).padEnd(5)} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pct}%) [${p.exit_reason ?? '?'}]`);
      }
    }
    if (o.length > 0) {
      console.log(`  OPEN :`);
      for (const p of o) {
        const ageMin = Math.round((Date.now() - new Date(p.entry_timestamp as string).getTime()) / 60000);
        console.log(`    ⏳ ${String(p.symbol).padEnd(13)} ${String(p.direction).padEnd(5)} entry=${p.entry_price} $${p.entry_notional_usd} (${ageMin}m)`);
      }
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  const gwr = grand.closed > 0 ? ((grand.wins / grand.closed) * 100).toFixed(0) : '—';
  console.log(`Σ TOTAL  —  réalisé ${grand.realized >= 0 ? '+' : ''}$${grand.realized.toFixed(2)} · ${grand.closed} closes (W${grand.wins}/L${grand.losses}, WR ${gwr}%) · ${grand.open} open ($${grand.deployed.toFixed(0)} déployé)`);

  // TRADER decisions récentes (5 derniers non-sentinel)
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`TRADER — dernières décisions (hors sentinels) :`);
  const { data: ta } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, confidence, action_applied, thesis')
    .order('decided_at', { ascending: false })
    .limit(20);
  let shown = 0;
  for (const d of ta ?? []) {
    if (String(d.thesis ?? '').includes('[CYCLE_TICK]') || String(d.thesis ?? '').includes('SENTINEL')) continue;
    const flag = d.action_applied ? '✅' : '⬜';
    console.log(`  ${flag} ${String(d.decided_at).slice(11, 19)} ${String(d.action_kind).padEnd(16)} ${(d.target_symbol ?? '-').padEnd(12)} conf=${d.confidence} — ${String(d.thesis ?? '').slice(0, 70)}`);
    if (++shown >= 6) break;
  }
})();
