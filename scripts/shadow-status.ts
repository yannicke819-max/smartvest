import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const SHADOW_IDS = ['a0000001-0000-0000-0000-000000000001','a0000002-0000-0000-0000-000000000002','a0000003-0000-0000-0000-000000000003'];
(async () => {
  // Positions for shadow portfolios
  const { data: pos, count } = await sb.from('lisa_positions')
    .select('portfolio_id, symbol, direction, status, entry_timestamp, entry_price', { count:'exact' })
    .in('portfolio_id', SHADOW_IDS)
    .order('entry_timestamp', { ascending: false })
    .limit(20);
  console.log(`Shadow positions total: ${count ?? 0}`);
  for (const p of (pos ?? [])) {
    console.log(`  ${p.entry_timestamp?.slice(11,19)} pid=${p.portfolio_id?.slice(0,8)} ${p.symbol} ${p.direction} entry=${p.entry_price} status=${p.status}`);
  }

  // user_shadow_signals for the 3
  const { data: sigs, count: sigc } = await sb.from('gainers_user_shadow_signals')
    .select('portfolio_id, symbol, decision, created_at', { count:'exact' })
    .in('portfolio_id', SHADOW_IDS)
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(`\nShadow user_signals total: ${sigc ?? 0}`);
  for (const s of (sigs ?? [])) console.log(`  ${s.created_at?.slice(11,19)} pid=${s.portfolio_id?.slice(0,8)} ${s.symbol} dec=${s.decision}`);

  // decision_log for the 3
  const { data: dl, count: dlc } = await sb.from('lisa_decision_log')
    .select('portfolio_id, timestamp, kind, summary', { count: 'exact' })
    .in('portfolio_id', SHADOW_IDS)
    .order('timestamp', { ascending: false })
    .limit(10);
  console.log(`\nShadow decision_log total: ${dlc ?? 0}`);
  for (const d of (dl ?? [])) console.log(`  ${d.timestamp?.slice(11,19)} pid=${d.portfolio_id?.slice(0,8)} [${d.kind}] ${(d.summary ?? '').slice(0,80)}`);
})();
