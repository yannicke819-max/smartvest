import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  // 1. Activate kill_switch to prevent re-opens
  const { error: ksErr } = await sb.from('lisa_session_configs')
    .update({
      kill_switch_active: true,
      autopilot_paused_reason: 'MANUAL',
      updated_at: new Date().toISOString(),
    })
    .eq('portfolio_id', PID);
  if (ksErr) { console.error('kill_switch failed:', ksErr); process.exit(1); }
  console.log('🛑 kill_switch_active=true + paused_reason=MANUAL');

  // 2. Close all remaining open positions
  const { data: pos } = await sb.from('lisa_positions')
    .select('id, symbol, direction, entry_price, entry_notional_usd')
    .eq('portfolio_id', PID)
    .eq('status', 'open');

  console.log(`\nFound ${pos?.length ?? 0} remaining open positions`);
  if (pos && pos.length > 0) {
    const now = new Date().toISOString();
    const ids = (pos as any[]).map(p => p.id);
    for (const p of pos as any[]) {
      console.log(`  ${p.symbol.padEnd(12)} ${p.direction.padEnd(6)} notional=$${p.entry_notional_usd}`);
    }
    const { error } = await sb.from('lisa_positions')
      .update({
        status: 'closed_invalidated',
        exit_price: null,
        exit_timestamp: now,
        exit_reason: '[FORCE_CLOSE] User request + kill_switch — TwelveData Asia stale',
        realized_pnl_usd: 0,
        realized_pnl_pct: 0,
        updated_at: now,
      })
      .in('id', ids);
    if (error) { console.error('UPDATE failed:', error); process.exit(1); }
    console.log(`✅ Closed ${pos.length} lisa_positions`);
  }

  // 3. Close all remaining open paper_trades
  const { data: paperOpen } = await sb.from('paper_trades')
    .select('id, symbol')
    .eq('portfolio_id', PID)
    .eq('status', 'open');

  if (paperOpen && paperOpen.length > 0) {
    const now = new Date().toISOString();
    await sb.from('paper_trades')
      .update({
        status: 'closed_invalidated',
        exit_timestamp: now,
        pnl_usd: 0,
        pnl_pct: 0,
      })
      .in('id', (paperOpen as any[]).map(r => r.id));
    console.log(`✅ Closed ${paperOpen.length} paper_trades`);
  }

  // 4. Final verification
  const { count: openLeft } = await sb.from('lisa_positions').select('id', { count: 'exact', head: true }).eq('portfolio_id', PID).eq('status', 'open');
  const { count: paperLeft } = await sb.from('paper_trades').select('id', { count: 'exact', head: true }).eq('portfolio_id', PID).eq('status', 'open');
  console.log(`\nFinal state:`);
  console.log(`  lisa_positions OPEN: ${openLeft}`);
  console.log(`  paper_trades OPEN:  ${paperLeft}`);
  console.log(`  kill_switch:        ACTIVE`);
})();
