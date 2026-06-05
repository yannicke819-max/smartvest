import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1) cherche tables macro / market context
  const tables = ['market_macro_snapshot', 'macro_snapshot', 'market_snapshot_log', 'macro_indicators', 'market_context_log', 'lisa_decision_log'];
  for (const t of tables) {
    try {
      const { count } = await sb.from(t).select('id', { count:'exact', head:true });
      if (count !== null) console.log(`${t}: ${count} rows`);
    } catch {}
  }
  
  // 2) lisa_decision_log : cherche les daily briefs / market_snapshot des 03-04-05/06
  const { data: briefs } = await sb.from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .in('kind', ['market_snapshot_collected','daily_brief_generated','macro_snapshot_collected'])
    .gte('timestamp','2026-06-03T00:00:00Z')
    .order('timestamp', { ascending: false })
    .limit(20);
  console.log(`\nmarket_snapshot events 03-05/06: ${briefs?.length ?? 0}`);
  for (const b of (briefs ?? []).slice(0,5)) {
    const p = b.payload as any;
    const vix = p?.snapshot?.vix ?? p?.vix ?? p?.dataQuality?.vix ?? p?.macro?.vix;
    const spy = p?.snapshot?.spy ?? p?.spy;
    console.log(`  ${b.timestamp.slice(0,16)} [${b.kind}] vix=${JSON.stringify(vix)} spy=${JSON.stringify(spy)}`);
  }
  
  // 3) Brut: cherche les "VIX" dans les briefings stockés
  const { data: contexts } = await sb.from('lisa_portfolio_snapshots')
    .select('timestamp, market_context_summary, portfolio_id')
    .gte('timestamp','2026-06-03T00:00:00Z')
    .not('market_context_summary','is',null)
    .order('timestamp', { ascending: false })
    .limit(8);
  console.log(`\nportfolio_snapshots avec market_context:`);
  for (const c of contexts ?? []) {
    const m = (c.market_context_summary ?? '').toString();
    const vixM = m.match(/VIX[:\s=]+([\d.]+)/i);
    const spyM = m.match(/SPY[:\s=]+([-\d.+%]+)/i);
    console.log(`  ${c.timestamp.slice(0,16)} pf=${c.portfolio_id?.slice(0,12)} VIX=${vixM?.[1] ?? '?'} SPY=${spyM?.[1] ?? '?'}  raw[0..120]=${m.slice(0,120)}`);
  }
}
main().catch(console.error);
