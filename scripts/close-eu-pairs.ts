import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TARGETS = ['NANO.PA', 'AMS.SW'];
(async () => {
  const { data: pos } = await sb.from('lisa_positions')
    .select('id, symbol, direction, entry_price, entry_notional_usd, quantity')
    .in('symbol', TARGETS).eq('status', 'open');
  if (!pos || pos.length === 0) { console.log('No matching open positions'); return; }
  console.log(`Found ${pos.length} positions to close:`);
  for (const p of pos as any[]) console.log(`  ${p.symbol.padEnd(10)} ${p.direction.padEnd(6)} entry=${p.entry_price} notional=$${p.entry_notional_usd}`);

  const now = new Date().toISOString();
  const ids = (pos as any[]).map(p => p.id);
  // Close at entry_price (break-even, no PnL) since live price unreliable.
  // status='closed_invalidated' → paper-broker traite comme "no trade happened" (refund entry fees).
  const { error } = await sb.from('lisa_positions')
    .update({
      status: 'closed_invalidated',
      exit_price: null,  // will be filled by paper-broker if needed
      exit_timestamp: now,
      exit_reason: '[MANUAL_CLOSE] cap libération avant US open — TwelveData stale + EODHD quota HARD BLOCK',
      realized_pnl_usd: 0,
      realized_pnl_pct: 0,
      updated_at: now,
    })
    .in('id', ids);
  if (error) { console.error('UPDATE failed:', error); process.exit(1); }

  // Audit log
  const portfolioId = 'b0000001-0000-0000-0000-000000000001';
  for (const p of pos as any[]) {
    await sb.from('lisa_decision_log').insert({
      portfolio_id: portfolioId, kind: 'position_closed',
      summary: `[MANUAL_CLOSE] ${p.symbol} ${p.direction.toUpperCase()} fermé manuellement (cap libération avant US open)`,
      rationale: `Cap maxOpenPositions=14 saturé à 10/14 (5 paires EU). TwelveData stale 3j + EODHD quota HARD BLOCK → close break-even pour libérer 4 slots avant US 14:30 UTC.`,
      payload: { position_id: p.id, symbol: p.symbol, direction: p.direction, entry_price: p.entry_price, source: 'manual_close_pre_us' },
      triggered_by: 'user_manual',
    });
  }
  console.log(`\n✅ Closed ${pos.length} positions. Cap : 10 → ${10-pos.length}/14 (slots libres : 4 → ${14-(10-pos.length)})`);
})();
