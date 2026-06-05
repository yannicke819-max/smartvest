import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 1. EODHD screener PA — ABVX présent ?
  const filters = encodeURIComponent(JSON.stringify([['exchange','=','PA'],['refund_1d_p','>',3]]));
  const url = `https://eodhd.com/api/screener?api_token=69e6325aa2c162.98850425&fmt=json&sort=refund_1d_p.desc&limit=30&filters=${filters}`;
  const res = await fetch(url);
  const json: any = await res.json();
  console.log('EODHD screener PA — ABVX entry:');
  const abvx = (json.data ?? []).find((r: any) => r.code === 'ABVX');
  console.log('  ', JSON.stringify(abvx));

  // 2. Shadow signals ABVX (toutes formes)
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, decision, created_at, entry_price')
    .or('symbol.like.%ABVX%')
    .gte('created_at', since24h)
    .order('created_at', { ascending: false });
  console.log(`\nShadow ABVX (toutes variantes) 24h: ${shadow?.length ?? 0}`);
  for (const s of shadow ?? []) console.log(`  ${s.created_at.slice(11,16)} ${s.symbol} ${s.decision}`);

  // 3. Check si le scanner a vu PA récent (autres tickers PA dans shadow)
  const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data: paSignals } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, decision')
    .like('symbol', '%.PA')
    .gte('created_at', since1h);
  console.log(`\nAll PA tickers shadow 60min: ${paSignals?.length ?? 0}`);
  const paBySym = new Map<string, string>();
  for (const s of paSignals ?? []) paBySym.set(s.symbol, s.decision);
  for (const [s, d] of paBySym) console.log(`  ${s} → ${d}`);
}
main();
