import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data: sample, error } = await sb.from('gainers_v1_shadow_signals')
    .select('*')
    .eq('decision', 'ACCEPT')
    .order('created_at', { ascending: false })
    .limit(1);
  console.log('error:', error);
  console.log('cols:', Object.keys((sample?.[0] ?? {}) as object));
}
main();
