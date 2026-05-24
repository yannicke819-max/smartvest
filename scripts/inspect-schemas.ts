import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const r = await sb.from('lisa_positions').select('*').limit(1);
  if (r.error) { console.error(r.error); return; }
  console.log('lisa_positions columns:');
  for (const k of Object.keys(r.data?.[0] ?? {})) console.log(' ', k);
  console.log('\npaper_trades columns:');
  const r2 = await sb.from('paper_trades').select('*').limit(1);
  for (const k of Object.keys(r2.data?.[0] ?? {})) console.log(' ', k);
}
main().catch(e => { console.error(e); process.exit(1); });
