import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  // ALL paper_trades opened today (any status)
  const { data } = await sb
    .from('paper_trades')
    .select('symbol, status, entry_price, exit_price, pnl_usd, pnl_pct, opened_at, closed_at, stop_loss, take_profit, size_usd')
    .gte('opened_at', todayStart.toISOString())
    .order('opened_at', { ascending: true });

  console.log(`\n=== paper_trades ALL today (${data?.length ?? 0}) ===`);
  let pnlTotal = 0;
  for (const p of (data ?? [])) {
    const ent = String(p.opened_at).slice(11, 16);
    const ext = p.closed_at ? String(p.closed_at).slice(11, 16) : '...';
    const usd = p.pnl_usd != null ? Number(p.pnl_usd) : null;
    const pct = p.pnl_pct != null ? Number(p.pnl_pct) : null;
    if (usd != null) pnlTotal += usd;
    const sign = (usd ?? 0) >= 0 ? '+' : '';
    const pnlStr = usd != null ? `pnl=${sign}${usd.toFixed(2)}$ (${sign}${pct?.toFixed(2)}%)` : 'pnl=?';
    console.log(`  ${ent} → ${ext}  ${p.symbol.padEnd(10)} ${String(p.status).padEnd(18)} entry=${Number(p.entry_price).toFixed(4)} exit=${p.exit_price ? Number(p.exit_price).toFixed(4) : '-'} ${pnlStr}`);
  }
  console.log(`\n  Σ realized today = ${pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)} $`);

  // Status counts today
  const counts = new Map<string, number>();
  for (const p of (data ?? [])) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  console.log(`\n  By status: ${Array.from(counts.entries()).map(([k,v]) => `${k}=${v}`).join(' ')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
