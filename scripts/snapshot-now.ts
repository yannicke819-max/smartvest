import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
const TODAY_START = '2026-05-26T00:00:00Z';

(async () => {
  const nowIso = new Date().toISOString();
  console.log(`Now: ${nowIso}`);

  const { data: open } = await sb.from('lisa_positions')
    .select('id, symbol, direction, asset_class, entry_price, entry_notional_usd, stop_loss_price, take_profit_price, entry_timestamp')
    .eq('portfolio_id', PID).eq('status', 'open')
    .order('entry_timestamp', { ascending: false });

  const { data: closed } = await sb.from('lisa_positions')
    .select('symbol, direction, asset_class, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, status, entry_timestamp, closed_at')
    .eq('portfolio_id', PID).gte('closed_at', TODAY_START).neq('status', 'open')
    .order('closed_at', { ascending: false });

  console.log(`\n=== ${(open?.length ?? 0)} OPEN POSITIONS ===`);
  for (const p of (open ?? [])) {
    const ageMin = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60000);
    console.log(`  ${p.symbol.padEnd(15)} ${p.direction.padEnd(6)} ${p.asset_class?.padEnd(8) ?? ''} entry=${String(p.entry_price).padStart(10)} notional=$${p.entry_notional_usd} SL=${p.stop_loss_price} TP=${p.take_profit_price}  age=${ageMin}m`);
  }

  console.log(`\n=== ${(closed?.length ?? 0)} CLOSED TODAY (UTC) ===`);
  let totalPnl = 0;
  for (const c of (closed ?? [])) {
    const pnl = Number(c.realized_pnl_usd ?? 0);
    totalPnl += pnl;
    const pct = c.realized_pnl_pct != null ? `${Number(c.realized_pnl_pct).toFixed(2)}%` : '-';
    const tag = pnl >= 0 ? '✅' : '❌';
    console.log(`  ${tag} ${c.symbol.padEnd(15)} ${c.direction.padEnd(6)} status=${c.status?.padEnd(20) ?? ''} pnl=$${pnl.toFixed(2).padStart(7)} (${pct.padStart(7)})  reason=${c.exit_reason ?? '-'}  closed=${c.closed_at?.slice(11,19) ?? '-'}`);
  }
  console.log(`\nTOTAL realized PnL today: $${totalPnl.toFixed(2)}`);
  console.log(`Trades fermés: ${closed?.length ?? 0}`);
  const wins = (closed ?? []).filter(c => Number(c.realized_pnl_usd ?? 0) > 0).length;
  console.log(`Win rate: ${wins}/${closed?.length ?? 0}`);

  // Progress to $400
  console.log(`\n=== OBJECTIF $400/jour ===`);
  console.log(`Réalisé: $${totalPnl.toFixed(2)} / $400  (${((totalPnl/400)*100).toFixed(1)}%)`);
  console.log(`Reste à faire: $${(400-totalPnl).toFixed(2)}`);
})();
