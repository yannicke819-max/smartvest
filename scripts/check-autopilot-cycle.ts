import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  // Check si autopilot_cycle_completed écrit récemment (every cycle, devrait être très fréquent si app up)
  const { data: cycles } = await sb.from('lisa_decision_log')
    .select('timestamp')
    .in('kind', ['autopilot_cycle_completed', 'autopilot_cycle_started', 'autopilot_cycle_completed_error'])
    .order('timestamp', { ascending: false })
    .limit(3);
  console.log('Last 3 autopilot_cycle_* entries:');
  for (const r of (cycles ?? []) as any[]) {
    const age = Math.floor((Date.now() - new Date(r.timestamp).getTime()) / 60_000);
    console.log(`  ${r.timestamp.slice(0,19)} (${age}min ago)`);
  }
  // Check gainers_user_shadow_signals (toujours écrit par scanner, même si pas d'open)
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('created_at, symbol')
    .order('created_at', { ascending: false })
    .limit(3);
  console.log('\nLast 3 gainers_user_shadow_signals:');
  for (const r of (shadow ?? []) as any[]) {
    const age = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000);
    console.log(`  ${r.created_at.slice(0,19)} (${age}min ago) ${r.symbol}`);
  }
})();
