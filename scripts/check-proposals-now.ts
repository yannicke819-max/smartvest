import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await sb.from('scanner_proposals')
    .select('symbol, asset_class, score, change_pct, status, created_at')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`\nNow: ${new Date().toISOString().slice(11,19)} UTC`);
  console.log(`Scanner_proposals TRADER 30min: ${data?.length ?? 0}\n`);
  for (const p of data ?? []) {
    console.log(`  ${p.created_at.slice(11,19)} ${p.symbol.padEnd(14)} ${p.asset_class.padEnd(20)} score=${Number(p.score).toFixed(2)} change=${Number(p.change_pct ?? 0).toFixed(1)}% status=${p.status}`);
  }
  // Aussi : shadow signals
  console.log(`\nShadow signals 30min par classe :`);
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('asset_class, decision').gte('created_at', since);
  const byCls = new Map<string, { total: number; accept: number }>();
  for (const s of shadow ?? []) {
    const acc = byCls.get(s.asset_class) ?? { total: 0, accept: 0 };
    acc.total++;
    if (s.decision === 'accept') acc.accept++;
    byCls.set(s.asset_class, acc);
  }
  for (const [c, s] of byCls) console.log(`  ${c.padEnd(22)} ${s.total} (accept ${s.accept})`);
}
main();
