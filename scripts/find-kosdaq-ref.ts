import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb.from('scanner_lessons').select('id, lesson_kind, scope, macro_condition, lesson_text, is_active')
    .or('lesson_text.like.%208710%,lesson_text.like.%200470%,lesson_text.like.%MIDDLE 28/05%');
  console.log(`Lessons qui mentionnent les KOSDAQ 28/05 : ${data?.length ?? 0}`);
  for (const l of data ?? []) {
    console.log(`\n${l.id?.slice(0,8)} [${l.lesson_kind}] scope=${l.scope} active=${l.is_active} macro=${l.macro_condition}`);
    console.log(`  ${(l.lesson_text as string).slice(0, 300)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
