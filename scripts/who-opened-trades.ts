import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';

  // 1. Le row complet des 2 trades — voir source, scanner_proposal_id
  console.log('═══ Source des 2 trades ═══');
  const { data } = await sb.from('lisa_positions').select('*')
    .in('symbol', ['216080.KQ', '601991.SHG'])
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', '2026-06-01T06:00:00Z');
  for (const t of data ?? []) {
    console.log(`\n${t.symbol}`);
    console.log(`  source/origin metadata:`);
    for (const k of Object.keys(t)) {
      if (k.includes('source') || k.includes('proposal') || k.includes('cycle') || k.includes('decision') || k.includes('origin') || k.includes('trigger') || k.includes('opened_by')) {
        console.log(`    ${k}: ${t[k]}`);
      }
    }
  }

  // 2. decision_log autour de 06:32 UTC
  console.log('\n═══ decision_log 06:30-06:36 UTC ═══');
  const { data: logs } = await sb.from('lisa_decision_log').select('timestamp, kind, summary, portfolio_id')
    .gte('timestamp', '2026-06-01T06:30:00Z')
    .lte('timestamp', '2026-06-01T06:36:00Z')
    .order('timestamp', { ascending: true });
  for (const l of logs ?? []) {
    console.log(`  ${l.timestamp?.slice(11,19)} ${(l.portfolio_id as string)?.slice(0,8)} ${l.kind?.padEnd(35)} ${(l.summary as string)?.slice(0,80)}`);
  }

  // 3. Cherche lesson "+$190" ou similaires
  console.log('\n═══ Lessons mentionnant $190 ou pre-cloche ═══');
  const { data: l2 } = await sb.from('scanner_lessons').select('id, macro_condition, lesson_text, applied, is_active')
    .or('lesson_text.ilike.%190%,lesson_text.ilike.%pre%cloche%,lesson_text.ilike.%KRX%clos%,lesson_text.ilike.%close.*before%market%')
    .eq('is_active', true);
  console.log(`Found ${l2?.length ?? 0} matching lessons`);
  for (const l of l2 ?? []) {
    console.log(`  ${l.id?.slice(0,8)} ${l.macro_condition} applied=${l.applied}`);
    console.log(`    ${(l.lesson_text as string)?.slice(0, 200).replace(/\n/g, ' | ')}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
