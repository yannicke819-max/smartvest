import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORT: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

async function main() {
  const { data: cfgs } = await sb.from('lisa_session_configs').select('*').in('portfolio_id', Object.keys(PORT));
  if (!cfgs) return;

  // Collect all keys
  const allKeys = new Set<string>();
  for (const c of cfgs) for (const k of Object.keys(c)) allKeys.add(k);

  // For each key, show 4 values side-by-side; only print if at least 2 differ
  const sortedKeys = Array.from(allKeys).sort();
  console.log(`Key                                          | TRADER       | HIGH         | MIDDLE       | SMALL`);
  console.log(`---------------------------------------------|--------------|--------------|--------------|------`);
  const order = ['b0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', 'a0000003-0000-0000-0000-000000000003'];
  const byPid: Record<string, any> = {};
  for (const c of cfgs) byPid[c.portfolio_id] = c;

  for (const k of sortedKeys) {
    if (k === 'portfolio_id' || k === 'updated_at' || k === 'created_at' || k === 'id') continue;
    const vals = order.map(pid => byPid[pid]?.[k]);
    const distinct = new Set(vals.map(v => JSON.stringify(v)));
    if (distinct.size > 1) {
      const fmt = (v: any) => {
        if (v == null) return 'null'.padEnd(12);
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return s.length > 12 ? s.slice(0,10) + '..' : s.padEnd(12);
      };
      console.log(`${k.padEnd(45)} | ${fmt(vals[0])} | ${fmt(vals[1])} | ${fmt(vals[2])} | ${fmt(vals[3])}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
