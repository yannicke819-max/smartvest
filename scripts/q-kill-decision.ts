import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Find decision log entries autour de quand HIGH a été killed
  const { data } = await sb.from('lisa_decision_log').select('timestamp, kind, summary, rationale')
    .gte('timestamp', '2026-06-01T06:30:00Z')
    .or('kind.ilike.%kill%,kind.ilike.%shadow%,summary.ilike.%kill%,rationale.ilike.%kill%')
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`Found ${data?.length ?? 0} matching logs:`);
  for (const d of data ?? []) {
    console.log(`\n${d.timestamp?.slice(0,19)?.replace('T',' ')} ${d.kind}`);
    console.log(`  ${(d.summary as string)?.slice(0,150)}`);
    if (d.rationale) console.log(`  rationale: ${(d.rationale as string)?.slice(0,200)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
