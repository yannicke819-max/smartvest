import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
(async () => {
  const { error } = await sb.from('lisa_session_configs').update({
    kill_switch_active: false,
    autopilot_paused_reason: null,
    updated_at: new Date().toISOString(),
  }).eq('portfolio_id', PID);
  if (error) { console.error(error); process.exit(1); }
  console.log('✅ kill_switch_active=false, autopilot_paused_reason=NULL');
  await sb.from('lisa_decision_log').insert({
    portfolio_id: PID, kind: 'autopilot_resumed',
    summary: '[MANUAL_RESUME] User reactivated autopilot for EU session (07:00 UTC open)',
    rationale: 'Asia bypass reverted on main, EU staleness threshold 900s, market opens in <2min',
    triggered_by: 'user_manual',
  });
})();
