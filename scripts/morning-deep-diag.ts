import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';

async function main() {
  const since = '2026-05-25T18:00:00Z'; // 12h back from morning
  console.log(`=== Deep diag depuis ${since} ===\n`);

  // 1. All decision_log kinds 12h
  console.log('1. KINDS decision_log 12h');
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('kind, timestamp, summary, payload')
    .eq('portfolio_id', PID)
    .gte('timestamp', since)
    .order('timestamp', { ascending: false });
  if (!events || events.length === 0) { console.log('   AUCUN EVENT 12h !!'); return; }
  console.log(`   Total: ${events.length}`);
  const byKind: Record<string, number> = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k.padEnd(45)} ${n}`);
  }

  // Timeline overall
  console.log(`\n2. TIMELINE EVENTS`);
  console.log(`   Premier : ${events[events.length - 1].timestamp}  ${events[events.length - 1].kind}`);
  console.log(`   Dernier : ${events[0].timestamp}  ${events[0].kind}`);

  // Open-related
  console.log(`\n3. EVENTS open-related (failed, reject, skip, block, debate, conviction, gate)`);
  const opens = events.filter((e) =>
    /open_failed|reject|skip|block|halt|veto|gate|debate|conviction|sizing|stale|sanity/i.test(e.kind),
  );
  console.log(`   Total: ${opens.length}`);
  for (const e of opens.slice(0, 25)) {
    console.log(`     ${e.timestamp}  ${e.kind.padEnd(38)}  ${(e.summary ?? '').slice(0, 80)}`);
  }

  // Shadow signals par heure
  console.log('\n4. SHADOW SIGNALS par heure UTC');
  const { data: shadows } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, decision, asset_class')
    .eq('portfolio_id', PID)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (shadows && shadows.length > 0) {
    console.log(`   Total : ${shadows.length}`);
    console.log(`   Premier : ${shadows[shadows.length - 1].created_at}`);
    console.log(`   Dernier : ${shadows[0].created_at}`);
    const byHour: Record<string, { tot: number; acc: number }> = {};
    for (const s of shadows) {
      const h = s.created_at.slice(0, 13) + 'h';
      byHour[h] ??= { tot: 0, acc: 0 };
      byHour[h].tot++;
      if (s.decision === 'accept') byHour[h].acc++;
    }
    for (const [h, { tot, acc }] of Object.entries(byHour).sort()) {
      console.log(`     ${h}  total=${tot.toString().padStart(4)}  accept=${acc.toString().padStart(3)}`);
    }
  } else console.log('   AUCUN shadow signal');

  // 5. Recent kinds with sample summaries (top 5 each)
  console.log('\n5. SAMPLES par kind (3 events récents par kind)');
  const topKinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
  for (const kind of topKinds) {
    const sample = events.filter((e) => e.kind === kind).slice(0, 3);
    console.log(`\n   [${kind}]`);
    for (const e of sample) {
      console.log(`     ${e.timestamp}  ${(e.summary ?? '').slice(0, 100)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
