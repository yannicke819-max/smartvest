import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  console.log(`Total 30min: ${data?.length ?? 0}`);
  const byCls = new Map<string, Map<string, number>>();
  for (const s of data ?? []) {
    if (!byCls.has(s.asset_class)) byCls.set(s.asset_class, new Map());
    const m = byCls.get(s.asset_class)!;
    m.set(s.decision, (m.get(s.decision) ?? 0) + 1);
  }
  for (const [cls, m] of byCls) {
    const total = [...m.values()].reduce((a,b)=>a+b,0);
    const accept = m.get('accept') ?? 0;
    const rejects = [...m].filter(([k]) => k !== 'accept').sort((a,b)=>b[1]-a[1]).slice(0,3);
    console.log(`  ${cls.padEnd(22)} total=${total} accept=${accept} rejects: ${rejects.map(([k,v])=>`${k}:${v}`).join(',')}`);
  }
}
main();
