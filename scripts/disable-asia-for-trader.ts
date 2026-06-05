import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';

async function main() {
  // 1. Avant : montre la config actuelle
  const { data: before } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto')
    .eq('portfolio_id', TRADER)
    .single();
  console.log('AVANT :');
  console.log(`  TRADER univers : us=${before?.gainers_universe_us} eu=${before?.gainers_universe_eu} asia=${before?.gainers_universe_asia} crypto=${before?.gainers_universe_crypto}`);

  // 2. UPDATE
  const { error } = await sb
    .from('lisa_session_configs')
    .update({ gainers_universe_asia: false })
    .eq('portfolio_id', TRADER);
  if (error) { console.error('UPDATE failed:', error); process.exit(1); }

  // 3. Après : vérifie
  const { data: after } = await sb
    .from('lisa_session_configs')
    .select('gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto')
    .eq('portfolio_id', TRADER)
    .single();
  console.log('\nAPRÈS :');
  console.log(`  TRADER univers : us=${after?.gainers_universe_us} eu=${after?.gainers_universe_eu} asia=${after?.gainers_universe_asia} crypto=${after?.gainers_universe_crypto}`);
  console.log('\n✅ Asia désactivée pour TRADER. Effet immédiat au prochain cycle scanner.');
}
main().catch(e => { console.error(e); process.exit(1); });
