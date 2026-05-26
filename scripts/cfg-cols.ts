import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
(async () => {
  const { data } = await sb.from('lisa_session_configs').select('*').limit(1);
  console.log('Columns:', Object.keys(data?.[0] ?? {}).join('\n  '));
})();
