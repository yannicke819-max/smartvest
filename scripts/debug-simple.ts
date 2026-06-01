import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const { data, count, error } = await sb.from('lisa_positions')
    .select('*', { count: 'exact', head: false })
    .eq('portfolio_id', 'b0000001-0000-0000-0000-000000000001')
    .eq('status', 'closed_target')
    .limit(3);
  console.log(`count=${count}, error=${error?.message}, returned=${data?.length}`);
  if (data && data.length > 0) {
    console.log('First row keys:', Object.keys(data[0]));
    console.log('First row:', JSON.stringify(data[0], null, 2).slice(0, 500));
  }
})();
