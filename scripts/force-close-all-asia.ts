import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';

(async () => {
  const { data: pos, error: fetchErr } = await sb.from('lisa_positions')
    .select('id, symbol, direction, entry_price, entry_notional_usd, quantity, asset_class')
    .eq('portfolio_id', PORTFOLIO_ID)
    .eq('status', 'open');

  if (fetchErr) { console.error('Fetch failed:', fetchErr); process.exit(1); }
  if (!pos || pos.length === 0) { console.log('No open positions to close.'); return; }

  console.log(`Found ${pos.length} open positions to FORCE CLOSE:\n`);
  let totalNotional = 0;
  for (const p of pos as any[]) {
    console.log(`  ${p.symbol.padEnd(12)} ${p.direction.padEnd(6)} entry=${p.entry_price.toString().padStart(10)} notional=$${p.entry_notional_usd}`);
    totalNotional += Number(p.entry_notional_usd);
  }
  console.log(`\nTotal exposure: $${totalNotional.toFixed(2)}`);

  const now = new Date().toISOString();
  const ids = (pos as any[]).map(p => p.id);

  const { error: updErr } = await sb.from('lisa_positions')
    .update({
      status: 'closed_invalidated',
      exit_price: null,
      exit_timestamp: now,
      exit_reason: '[FORCE_CLOSE] User request — TwelveData Asia stale (Friday prices) + markets closed, no reliable exit pricing',
      realized_pnl_usd: 0,
      realized_pnl_pct: 0,
      updated_at: now,
    })
    .in('id', ids);

  if (updErr) { console.error('UPDATE failed:', updErr); process.exit(1); }

  // Mirror in paper_trades (status='closed_manual' / 'closed_invalidated')
  const symbols = [...new Set((pos as any[]).map(p => p.symbol))];
  const { data: paperRows } = await sb.from('paper_trades')
    .select('id, symbol')
    .eq('portfolio_id', PORTFOLIO_ID)
    .eq('status', 'open')
    .in('symbol', symbols);

  if (paperRows && paperRows.length > 0) {
    await sb.from('paper_trades')
      .update({
        status: 'closed_invalidated',
        exit_timestamp: now,
        pnl_usd: 0,
        pnl_pct: 0,
      })
      .in('id', (paperRows as any[]).map(r => r.id));
    console.log(`\n✅ Mirrored close on ${paperRows.length} paper_trades rows`);
  }

  // Audit log entries
  for (const p of pos as any[]) {
    await sb.from('lisa_decision_log').insert({
      portfolio_id: PORTFOLIO_ID,
      kind: 'position_closed',
      summary: `[FORCE_CLOSE] ${p.symbol} ${p.direction.toUpperCase()} fermé manuellement (TwelveData Asia stale + markets closed)`,
      rationale: `User-requested force close. TwelveData /quote returns Friday 22/05 prices for all .KO/.KQ/.SHE/.SHG tickers (ages 28h-4.25d). No reliable live price available to evaluate SL/TP. Closing break-even (exit=entry) to release capital before US open.`,
      payload: {
        position_id: p.id,
        symbol: p.symbol,
        direction: p.direction,
        entry_price: p.entry_price,
        notional_usd: p.entry_notional_usd,
        source: 'force_close_asia_stale',
      },
      triggered_by: 'user_manual',
    });
  }

  console.log(`\n✅ Closed ${pos.length} positions. Total exposure released: $${totalNotional.toFixed(2)}`);
})();
