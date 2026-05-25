import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  console.log(`\n=== PROD STATUS — ${new Date().toISOString().slice(0,19)} UTC ===\n`);

  // 1. Heartbeat scanner (toujours actif si app up)
  const { data: shadow } = await sb.from('gainers_user_shadow_signals')
    .select('created_at, symbol, decision').order('created_at', { ascending: false }).limit(5);
  console.log('─── Heartbeat scanner (gainers_user_shadow_signals) ───');
  for (const r of (shadow ?? []) as any[]) {
    const age = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60_000);
    console.log(`  ${r.created_at.slice(11,19)} (${String(age).padStart(3)}min ago) ${r.symbol.padEnd(16)} ${r.decision}`);
  }

  // 2. Decision_log derniers 30 min
  const since30 = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: dl } = await sb.from('lisa_decision_log').select('kind, timestamp, summary')
    .gte('timestamp', since30).order('timestamp', { ascending: false }).limit(50);
  const counts: Record<string, number> = {};
  for (const r of (dl ?? []) as any[]) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  console.log(`\n─── Decision_log 30min (total: ${dl?.length ?? 0}) ───`);
  for (const [k, n] of Object.entries(counts).sort((a,b) => (b[1] as number) - (a[1] as number))) {
    console.log(`  ${String(n).padStart(4)} ${k}`);
  }

  // 3. Risk-manager + scout activity
  const { data: rm } = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .in('kind', ['risk_manager_thesis_broken', 'opportunity_scout_opened'])
    .gte('timestamp', since30).order('timestamp', { ascending: false }).limit(20);
  console.log(`\n─── V2 RiskManager + Scout 30min (total: ${rm?.length ?? 0}) ───`);
  for (const r of (rm ?? []) as any[]) {
    console.log(`  ${r.timestamp.slice(11,19)} ${(r.summary ?? '').slice(0, 100)}`);
  }

  // 4. Positions
  const { count: openCount } = await sb.from('lisa_positions').select('*', { count: 'exact', head: true }).eq('status', 'open');
  console.log(`\n─── Positions OPEN: ${openCount} ───`);

  // 5. Last decision_log overall age
  const { data: last } = await sb.from('lisa_decision_log').select('kind, timestamp').order('timestamp', { ascending: false }).limit(1);
  if (last && last[0]) {
    const ageMin = Math.floor((Date.now() - new Date((last[0] as any).timestamp).getTime()) / 60_000);
    console.log(`\nDernière entry decision_log : ${(last[0] as any).timestamp.slice(0,19)} (${ageMin} min ago)  kind=${(last[0] as any).kind}`);
  }
})();
