import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  // Use a portfolio that exists (the main one) and see what profile it has
  const { data: existing } = await sb.from('lisa_session_configs').select('profile, gainers_max_open_positions').limit(3);
  console.log('Existing rows:', JSON.stringify(existing, null, 2));

  // Try a minimal insert with just 'sniper_mode'
  const { data, error } = await sb.from('lisa_session_configs').insert({
    user_id: '5f164201-9736-4867-8756-a1653d65fd1c',
    portfolio_id: 'a0000099-0000-0000-0000-000000000099',
    profile: 'sniper_mode',  // try different value
    capital_usd: 100,
    base_currency: 'USD',
    gainers_max_open_positions: 5,
  }).select();
  console.log('Insert sniper_mode minimal:', error?.message ?? 'OK', data ? JSON.stringify(data) : '');

  // Clean
  if (!error) await sb.from('lisa_session_configs').delete().eq('portfolio_id', 'a0000099-0000-0000-0000-000000000099');
})();
