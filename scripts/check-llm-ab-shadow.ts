import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { count, data, error } = await sb
    .from('llm_ab_shadow_decisions')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.log('ERR:', error.message);
    return;
  }
  console.log(`Total rows = ${count}`);
  if (!data || data.length === 0) {
    console.log('\n⚠️  Table existe mais vide — aucun call site shadow (lessons, risk, coach, brief) n\'a encore tourné depuis le déploiement PR #523');
    return;
  }
  console.log('\nLast 10 rows:');
  for (const r of data.slice(0, 10)) {
    console.log(JSON.stringify(r));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
