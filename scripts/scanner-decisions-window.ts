import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORT: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

async function main() {
  // 1. Scanner shadow signals around 02:25-02:30
  console.log('═══ Scanner shadow signals 02:20-02:30 par portfolio ═══');
  const { data: sigs } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, portfolio_id, symbol, change_pct_1m, path_eff, persistence_score, decision, notional_usd, sim_run_at')
    .gte('created_at', '2026-06-01T02:20:00Z')
    .lte('created_at', '2026-06-01T02:30:00Z')
    .order('created_at', { ascending: true });
  if (!sigs || sigs.length === 0) console.log('  (vide)');
  else for (const s of sigs) {
    const port = PORT[s.portfolio_id as string] ?? (s.portfolio_id as string)?.slice(0,8);
    console.log(`  ${s.created_at?.slice(11,19)}  ${port.padEnd(8)} ${s.symbol?.padEnd(14)} ch=${s.change_pct_1m?.toFixed(2)}% pe=${s.path_eff} ps=${s.persistence_score} notional=$${s.notional_usd} dec=${s.decision}`);
  }

  // 2. Per portfolio counts
  console.log('\n═══ Count signals 02:20-02:30 par portfolio ═══');
  const counts: Record<string, number> = {};
  for (const s of sigs ?? []) {
    const pid = s.portfolio_id as string;
    counts[pid] = (counts[pid] || 0) + 1;
  }
  for (const [pid, c] of Object.entries(counts)) console.log(`  ${PORT[pid] ?? pid.slice(0,8)}: ${c} signals`);

  // 3. Specific signals for 241520.KQ and 216080.KQ
  console.log('\n═══ Signaux spécifiques 241520.KQ + 216080.KQ depuis 02:00 UTC ═══');
  const { data: ksigs } = await sb
    .from('gainers_user_shadow_signals')
    .select('created_at, portfolio_id, symbol, change_pct_1m, path_eff, persistence_score, decision, notional_usd')
    .in('symbol', ['241520.KQ', '216080.KQ'])
    .gte('created_at', '2026-06-01T02:00:00Z')
    .order('created_at', { ascending: true });
  if (!ksigs || ksigs.length === 0) console.log('  (aucun signal sur ces 2 KOSDAQ — décisions prises ailleurs ?)');
  else for (const s of ksigs) {
    const port = PORT[s.portfolio_id as string] ?? (s.portfolio_id as string)?.slice(0,8);
    console.log(`  ${s.created_at?.slice(11,19)}  ${port.padEnd(8)} ${s.symbol?.padEnd(14)} ch=${s.change_pct_1m?.toFixed(2)}% pe=${s.path_eff} ps=${s.persistence_score} notional=$${s.notional_usd} dec=${s.decision}`);
  }

  // 4. Trades par portfolio pour confirmation
  console.log('\n═══ Confirmation : trades ouverts à 02:26 UTC ═══');
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, portfolio_id, entry_notional_usd, entry_price, status, entry_timestamp, exit_timestamp, realized_pnl_usd, exit_reason, sl_pct, tp_pct, stop_loss_price, take_profit_price')
    .gte('entry_timestamp', '2026-06-01T02:25:00Z')
    .lte('entry_timestamp', '2026-06-01T02:27:00Z')
    .order('entry_timestamp', { ascending: true });
  for (const p of positions ?? []) {
    const port = PORT[p.portfolio_id as string] ?? (p.portfolio_id as string)?.slice(0,8);
    console.log(`  ${p.entry_timestamp?.slice(11,19)}  ${port.padEnd(8)} ${p.symbol?.padEnd(14)} entry=$${p.entry_price} notional=$${p.entry_notional_usd} SL=$${p.stop_loss_price} TP=$${p.take_profit_price} exit=${p.exit_reason}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
