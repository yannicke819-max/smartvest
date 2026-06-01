import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Test if columns added by migration 0182 exist
  const { data, error } = await sb.from('llm_ab_shadow_decisions')
    .select('target_id, outcome_pnl_pct, outcome_label, outcome_resolved_at')
    .limit(1);
  console.log('Err:', error?.message ?? 'none');
  if (!error) {
    console.log('✅ Migration 0182 appliquée — colonnes target_id + outcome_* présentes');
    if (data?.[0]) {
      console.log('Sample:', JSON.stringify(data[0]));
    } else {
      console.log('(table vide pour la query)');
    }
  } else {
    console.log('❌ Migration 0182 PAS appliquée — colonne manquante');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
