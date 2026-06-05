/**
 * Réactive EU + Crypto sur TRADER gainers.
 *
 * Contexte : EU avait été désactivé hier soir (cf. PR #596) car TwelveData
 * stream pas live sur LSE/Euronext (stale_twelvedata). Avec PR #597 et le
 * secret GAINERS_STALE_SOURCE_GUARD_ENABLED=false, le scanner peut maintenant
 * ouvrir EU malgré source stale.
 *
 * Crypto n'avait jamais été activé. Binance fonctionne 24/7, ses prix sont
 * fiables (WS direct + REST fallback fix db097ab du 03/06).
 *
 *   npx tsx scripts/enable-eu-crypto-for-trader.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';

  const { data: before } = await sb
    .from('lisa_session_configs')
    .select('gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .single();
  console.log('AVANT :', JSON.stringify(before));

  const { error } = await sb
    .from('lisa_session_configs')
    .update({
      gainers_universe_eu: true,
      gainers_universe_crypto: true,
    })
    .eq('portfolio_id', TRADER_PORTFOLIO);

  if (error) {
    console.error('Update failed:', error);
    process.exit(1);
  }

  const { data: after } = await sb
    .from('lisa_session_configs')
    .select('gainers_universe_us, gainers_universe_eu, gainers_universe_asia, gainers_universe_crypto')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .single();
  console.log('APRÈS :', JSON.stringify(after));
  console.log('\n✅ TRADER scanner inclura EU + Crypto au prochain cycle (≤15min).');
}
main().catch(e => { console.error(e); process.exit(1); });
