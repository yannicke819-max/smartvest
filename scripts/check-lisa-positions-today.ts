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
  const { data, error } = await sb
    .from('lisa_positions')
    .select('symbol, status, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, entry_timestamp, exit_timestamp, asset_class, quantity')
    .gte('entry_timestamp', todayStart.toISOString())
    .order('entry_timestamp', { ascending: true });
  if (error) console.error('ERR:', error);

  console.log(`\n=== lisa_positions ALL today (${data?.length ?? 0}) ===`);
  let pnlTotal = 0;
  let nWin = 0, nLoss = 0;
  for (const p of (data ?? [])) {
    const ent = String(p.entry_timestamp).slice(11, 16);
    const ext = p.exit_timestamp ? String(p.exit_timestamp).slice(11, 16) : '...';
    const usd = p.realized_pnl_usd != null ? Number(p.realized_pnl_usd) : null;
    const pct = p.realized_pnl_pct != null ? Number(p.realized_pnl_pct) : null;
    if (usd != null) {
      pnlTotal += usd;
      if (usd > 0) nWin++; else if (usd < 0) nLoss++;
    }
    const sign = (usd ?? 0) >= 0 ? '+' : '';
    const pnlStr = usd != null ? `${sign}${usd.toFixed(2)}$ (${sign}${pct?.toFixed(2)}%)` : 'open';
    const notional = Number(p.quantity ?? 0) * Number(p.entry_price ?? 0);
    console.log(`  ${ent} → ${ext}  ${p.symbol.padEnd(10)} ${String(p.status).padEnd(20)} entry=${Number(p.entry_price).toFixed(4)} exit=${p.exit_price ? Number(p.exit_price).toFixed(4) : '-'} ${pnlStr}  notional=$${notional.toFixed(0)}`);
  }
  console.log(`\n  Σ realized today = ${pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)} $  (${nWin}W / ${nLoss}L)`);

  // status counts
  const counts = new Map<string, number>();
  for (const p of (data ?? [])) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  console.log(`  By status: ${Array.from(counts.entries()).map(([k,v]) => `${k}=${v}`).join(' ')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
