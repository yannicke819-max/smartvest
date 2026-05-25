import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
(async () => {
  const { data: b } = await sb.from('lisa_session_configs')
    .select('gainers_cooldown_minutes, gainers_post_sl_cooldown_min').eq('portfolio_id', PID).single();
  console.log('BEFORE: gainers_cooldown_minutes =', (b as any)?.gainers_cooldown_minutes, '· post_sl =', (b as any)?.gainers_post_sl_cooldown_min);
  const { error } = await sb.from('lisa_session_configs')
    .update({ gainers_cooldown_minutes: 60, updated_at: new Date().toISOString() })
    .eq('portfolio_id', PID);
  if (error) { console.error(error); process.exit(1); }
  const { data: a } = await sb.from('lisa_session_configs')
    .select('gainers_cooldown_minutes').eq('portfolio_id', PID).single();
  console.log(`AFTER : gainers_cooldown_minutes = ${(a as any)?.gainers_cooldown_minutes}\n✅ cooldown 5→60 min`);
})();
