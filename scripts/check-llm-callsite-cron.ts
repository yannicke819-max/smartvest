import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Check derniers logs des 4 services dans decision_log ou autres tables
  const today = new Date().toISOString().slice(0, 10);
  const since7d = new Date(Date.now() - 7 * 24 * 3600e3).toISOString();

  // 1. lisa_decision_log — chercher événements scanner_postmortem / risk_monitor / strategy_coach / daily_brief
  const patterns = ['scanner_postmortem', 'risk_monitor', 'strategy_coach', 'daily_brief', 'daily_catalyst', 'open_position_risk', 'lessons_generation'];
  console.log('=== Activité 4 services LLM périphériques (7 derniers jours) ===\n');
  for (const p of patterns) {
    const { count } = await sb
      .from('lisa_decision_log')
      .select('*', { count: 'exact', head: true })
      .ilike('kind', `%${p}%`)
      .gte('created_at', since7d);
    console.log(`  ${p.padEnd(25)} → ${count ?? 0} logs sur 7d`);
  }

  // 2. lisa_decision_log — distinct kinds today (top 30)
  const { data: logs } = await sb
    .from('lisa_decision_log')
    .select('kind')
    .gte('created_at', today + 'T00:00:00Z')
    .limit(2000);
  if (logs) {
    const counts: Record<string, number> = {};
    for (const l of logs) counts[l.kind] = (counts[l.kind] || 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`\n=== Top 25 decision_log kinds today (${logs.length} total) ===`);
    for (const [k, v] of sorted) console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
