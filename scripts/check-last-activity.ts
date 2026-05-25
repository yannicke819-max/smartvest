import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const { data: latest } = await sb.from('lisa_decision_log').select('kind, timestamp, summary').order('timestamp', { ascending: false }).limit(3);
  console.log('Last 3 decision_log entries (any time):');
  for (const r of (latest ?? []) as any[]) {
    const ageMs = Date.now() - new Date(r.timestamp).getTime();
    const ageMin = Math.floor(ageMs / 60_000);
    console.log(`  ${r.timestamp.slice(0,19)} (${ageMin}min ago) ${r.kind.padEnd(30)} ${(r.summary ?? '').slice(0, 70)}`);
  }
  const { count: openCount } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('status', 'open');
  console.log(`Positions OPEN: ${openCount}`);
})();
