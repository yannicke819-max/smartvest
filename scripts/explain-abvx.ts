import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 1. La position
  const { data: pos } = await sb.from('lisa_positions')
    .select('*')
    .eq('symbol','ABVX.US')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .order('entry_timestamp', { ascending: false })
    .limit(1);
  const p = pos?.[0];
  if (!p) { console.log('Position non trouvée'); return; }
  
  console.log('=== ABVX.US position ===');
  console.log(`entry_ts     = ${p.entry_timestamp}`);
  console.log(`exit_ts      = ${p.exit_timestamp}`);
  console.log(`entry_price  = ${p.entry_price}`);
  console.log(`exit_price   = ${p.exit_price}`);
  console.log(`stop_loss    = ${p.stop_loss_price}`);
  console.log(`take_profit  = ${p.take_profit_price}`);
  console.log(`status       = ${p.status}`);
  console.log(`exit_reason  = ${p.exit_reason}`);
  console.log(`notional     = $${p.entry_notional_usd}`);
  console.log(`qty          = ${p.quantity}`);
  console.log(`realized_pnl = $${p.realized_pnl_usd} (${p.realized_pnl_pct}%)`);
  console.log(`source       = ${p.source}`);
  console.log(`venue_source = ${(p.venue_fee_detail as any)?.source}`);
  
  // 2. Distance entry → SL
  const entryPx = Number(p.entry_price);
  const slPx = p.stop_loss_price ? Number(p.stop_loss_price) : null;
  const exitPx = Number(p.exit_price);
  if (entryPx && slPx) {
    const slDist = ((entryPx - slPx) / entryPx * 100);
    console.log(`\nSL distance from entry = ${slDist.toFixed(2)}%`);
    console.log(`Exit price (${exitPx}) vs SL price (${slPx}): exit < SL ? ${exitPx < slPx}`);
  }
  
  // 3. Decision log autour de l'exit
  const exitMs = new Date(p.exit_timestamp).getTime();
  const before = new Date(exitMs - 120_000).toISOString();
  const after = new Date(exitMs + 30_000).toISOString();
  const { data: logs } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .gte('timestamp', before)
    .lte('timestamp', after)
    .order('timestamp', { ascending: true });
  console.log(`\n=== Decision log autour du close (${(logs?.length ?? 0)} events) ===`);
  for (const l of logs ?? []) {
    const rel = (l.summary ?? '').includes('ABVX') || JSON.stringify(l.payload ?? {}).includes('ABVX') || ['mechanical_close','position_closed','reactive_exit','stop_target','sl_hit','danger_zone','fade'].some(k=>l.kind.includes(k));
    if (rel) {
      console.log(`  ${l.timestamp.slice(11,19)} [${l.kind}] ${(l.summary ?? '').slice(0,120)}`);
      const pay = l.payload as any;
      if (pay && (pay.symbol === 'ABVX.US' || pay.position_id === p.id)) {
        console.log(`     payload: ${JSON.stringify(pay).slice(0, 200)}`);
      }
    }
  }
  
  // 4. Cherche le log d'OUVERTURE
  console.log('\n=== Log ouverture ABVX ===');
  const entryMs = new Date(p.entry_timestamp).getTime();
  const beforeOpen = new Date(entryMs - 60_000).toISOString();
  const afterOpen = new Date(entryMs + 30_000).toISOString();
  const { data: openLogs } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id','b0000001-0000-0000-0000-000000000001')
    .gte('timestamp', beforeOpen).lte('timestamp', afterOpen);
  for (const l of openLogs ?? []) {
    const txt = (l.summary ?? '') + JSON.stringify(l.payload ?? {});
    if (txt.includes('ABVX')) {
      console.log(`  ${l.timestamp.slice(11,19)} [${l.kind}] ${(l.summary ?? '').slice(0,150)}`);
    }
  }
}
main().catch(console.error);
