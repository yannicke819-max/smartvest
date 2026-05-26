import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const { data } = await sb.from('lisa_session_configs').select('user_id, portfolio_id, capital_usd, gainers_position_pct, gainers_max_open_positions, gainers_min_persistence_score, gainers_min_path_efficiency').limit(5);
  console.log(JSON.stringify(data, null, 2));
})();
