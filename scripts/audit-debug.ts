import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const today = new Date(); today.setUTCHours(0,0,0,0);
const since1h = new Date(Date.now() - 3600_000);

async function main() {
  // Count all shadow signals last hour
  const { count: total1h } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', since1h.toISOString());
  console.log('Total shadow signals last 1h:', total1h);

  // ACCEPT last 1h
  const { count: accept1h } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .eq('decision', 'ACCEPT')
    .gte('created_at', since1h.toISOString());
  console.log('ACCEPT last 1h:', accept1h);

  // Decision distinct values
  const { data: distinct } = await sb.from('gainers_v1_shadow_signals')
    .select('decision')
    .gte('created_at', since1h.toISOString())
    .limit(100);
  const uniq = new Set((distinct ?? []).map((d: any) => d.decision));
  console.log('Distinct decisions last 1h:', Array.from(uniq));

  // Sample of ACCEPT
  const { data: sample } = await sb.from('gainers_v1_shadow_signals')
    .select('symbol, exchange, decision, score, change_pct, created_at')
    .eq('decision', 'ACCEPT')
    .gte('created_at', since1h.toISOString())
    .order('created_at', { ascending: false })
    .limit(5);
  console.log('Sample ACCEPT:', JSON.stringify(sample, null, 2));

  // Count since midnight
  const { count: totalToday } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', today.toISOString());
  console.log('\nTotal signals since 00:00 UTC:', totalToday);

  const { count: acceptToday } = await sb.from('gainers_v1_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .eq('decision', 'ACCEPT')
    .gte('created_at', today.toISOString());
  console.log('ACCEPT since 00:00 UTC:', acceptToday);
}
main();
