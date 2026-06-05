import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const now = new Date().toISOString();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();

  // Toutes les proposals 60min avec status + expires_at
  const { data } = await sb
    .from('scanner_proposals')
    .select('symbol, score, status, created_at, expires_at')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`Total scanner_proposals 60min: ${data?.length ?? 0}`);
  console.log(`Now: ${now}\n`);

  const statusCounts = new Map<string, number>();
  let pendingActive = 0;
  for (const p of data ?? []) {
    const isExpired = p.expires_at && p.expires_at < now;
    const status = p.status ?? 'NULL';
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    if (status === 'pending' && !isExpired) pendingActive++;
    console.log(`  ${p.created_at.slice(11,19)} ${p.symbol.padEnd(14)} score=${p.score} status=${status.padEnd(12)} expires=${p.expires_at?.slice(11,19)} ${isExpired ? '⏰EXPIRED' : '✓'}`);
  }
  console.log(`\nStatus distribution:`);
  for (const [s, n] of statusCounts) console.log(`  ${s}: ${n}`);
  console.log(`\nPending & non-expired RIGHT NOW: ${pendingActive}`);
}
main().catch(e => { console.error(e); process.exit(1); });
