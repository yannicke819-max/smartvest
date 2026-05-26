import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  // Cherche TOUS les hour_blacklist_suggestion (cron sunday)
  const { data: all } = await sb.from('lisa_decision_log')
    .select('kind, summary, rationale, payload, timestamp')
    .eq('kind', 'hour_blacklist_suggestion')
    .order('timestamp', { ascending: false }).limit(10);
  console.log(`Total hour_blacklist_suggestion (anytime): ${all?.length ?? 0}`);
  if (all && all.length) for (const e of all as any[]) {
    console.log(`\n--- ${e.timestamp?.slice(0,19)} ---`);
    console.log(`summary: ${e.summary}`);
    console.log(`rationale: ${e.rationale}`);
    const p = e.payload ?? {};
    console.log(`add: ${JSON.stringify(p.add ?? [])}`);
    console.log(`remove: ${JSON.stringify(p.remove ?? [])}`);
    console.log(`lookback_days: ${p.lookback_days}`);
  }

  // Aussi cherche kinds proches
  const { data: kinds } = await sb.from('lisa_decision_log')
    .select('kind').gte('timestamp', new Date(Date.now() - 14 * 86400000).toISOString()).limit(2000);
  if (kinds) {
    const set: Record<string, number> = {};
    for (const k of kinds as any[]) set[k.kind] = (set[k.kind] ?? 0) + 1;
    console.log('\n=== Decision_log kinds last 14d (looking for analyzer-like) ===');
    for (const [k, n] of Object.entries(set).sort((a, b) => b[1] - a[1])) {
      if (/hour|blacklist|analyzer|edge/i.test(k) || n > 10) console.log(`  ${k.padEnd(40)} ${n}`);
    }
  }
})();
