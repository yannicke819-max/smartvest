import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  const sinceLast10 = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, count } = await sb.from('lisa_decision_log')
    .select('kind, timestamp, summary', { count: 'exact' })
    .gte('timestamp', sinceLast10)
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`Decision_log entries last 10 min: ${count ?? 0}`);
  if (data && data.length > 0) {
    const counts: Record<string, number> = {};
    for (const r of data as any[]) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    console.log('Breakdown:');
    for (const [k, n] of Object.entries(counts).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`  ${String(n).padStart(4)} ${k}`);
    }
    console.log('\nLatest 5:');
    for (const r of (data ?? []).slice(0, 5) as any[]) {
      console.log(`  ${r.timestamp.slice(11, 19)} ${r.kind.padEnd(35)} ${(r.summary ?? '').slice(0, 80)}`);
    }
  } else {
    console.log('⚠️  ZÉRO activité depuis 10min — API probablement DOWN, vérifier Fly');
  }
})();
