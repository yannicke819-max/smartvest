import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PID = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  // 1. Show current value
  const { data: before } = await sb
    .from('lisa_session_configs')
    .select('gainers_asia_strictness_boost, gainers_min_persistence_score, gainers_min_path_efficiency')
    .eq('portfolio_id', PID)
    .single();
  console.log('AVANT update :');
  console.log(`  asia_strictness_boost   = ${before?.gainers_asia_strictness_boost}`);
  console.log(`  min_persistence_score   = ${before?.gainers_min_persistence_score}`);
  console.log(`  min_path_efficiency     = ${before?.gainers_min_path_efficiency}`);
  console.log(`  ⇒ effective Asia min    = ${(before?.gainers_min_persistence_score ?? 0.67) + (before?.gainers_asia_strictness_boost ?? 0.15)} = Math.round(${((before?.gainers_min_persistence_score ?? 0.67) + (before?.gainers_asia_strictness_boost ?? 0.15)) * 6} ) = ${Math.round(((before?.gainers_min_persistence_score ?? 0.67) + (before?.gainers_asia_strictness_boost ?? 0.15)) * 6)}/6 TF requis`);

  // 2. Set boost to 0 (neutralize) — keep column for retro-compat
  console.log('\n🚀 Setting gainers_asia_strictness_boost = 0 ...');
  const { error } = await sb
    .from('lisa_session_configs')
    .update({ gainers_asia_strictness_boost: 0 })
    .eq('portfolio_id', PID);
  if (error) { console.error('UPDATE failed:', error.message); process.exit(1); }

  // 3. Verify
  const { data: after } = await sb
    .from('lisa_session_configs')
    .select('gainers_asia_strictness_boost')
    .eq('portfolio_id', PID)
    .single();
  console.log(`\nAPRÈS update : asia_strictness_boost = ${after?.gainers_asia_strictness_boost}`);
  console.log(`  ⇒ Asia désormais traité comme US/EU : ${Math.round((before?.gainers_min_persistence_score ?? 0.67) * 6)}/6 TF requis`);
}
main();
