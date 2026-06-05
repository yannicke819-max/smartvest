/**
 * Diagnostic du cron oversold-mistral-exit (toutes les 15min) + scanner 21:15 UTC.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const NAMES: Record<string, string> = {
  'b0000001-0000-0000-0000-000000000001': 'TRADER',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};
const label = (id: string) => NAMES[id] ?? id.slice(0, 8);

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' OVERSOLD-MISTRAL-EXIT (15min) + OVERSOLD-DAILY-SCAN (21:15 UTC)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // [1] Positions ouvertes scope cron
  const { data: openPos } = await sb
    .from('lisa_positions')
    .select('id, portfolio_id, symbol, entry_price, entry_timestamp, asset_class, venue_fee_detail')
    .eq('status', 'open')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .order('entry_timestamp', { ascending: false });

  console.log(`[1] POSITIONS OUVERTES scanner_oversold : ${openPos?.length ?? 0}`);
  if (openPos?.length) {
    const byPf = new Map<string, number>();
    for (const p of openPos) byPf.set(p.portfolio_id, (byPf.get(p.portfolio_id) ?? 0) + 1);
    for (const [pf, n] of byPf) console.log(`    ${label(pf).padEnd(8)} → ${n} pos`);
  }

  // [2] Décisions cron Mistral (15min)
  const { data: decisions, count: decCount } = await sb
    .from('lisa_decision_log')
    .select('id, created_at, portfolio_id, summary, payload', { count: 'exact' })
    .eq('kind', 'oversold_mistral_gain_pick')
    .order('created_at', { ascending: false })
    .limit(10);

  console.log(`\n[2] DÉCISIONS oversold_mistral_gain_pick (total) : ${decCount ?? 0}`);
  for (const d of decisions ?? []) {
    const p = (d.payload as Record<string, unknown> | null) ?? {};
    const t = new Date(d.created_at as string).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`    ${t}  ${String(p.symbol).padEnd(10)}  conf=${p.mistral_confidence}  rationale=${p.mistral_rationale}`);
  }

  // [3] Logs cron 15min "cycle done" — repérables via decision_log si append, ou table dédiée
  // Le cron n'écrit dans decision_log QUE si CLOSE → si HOLD partout, silence.
  console.log('\n[3] Note : le cron n\'écrit dans decision_log QUE sur CLOSE.');
  console.log('    Pour les logs "cycle done — positions=N evaluated=X" : voir fly logs.');

  // [4] Scanner 21:15 UTC — historique des scans daily
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: scans, count: scanCount } = await sb
    .from('lisa_decision_log')
    .select('id, created_at, portfolio_id, summary, payload', { count: 'exact' })
    .in('kind', ['oversold_scanner_completed', 'oversold_scanner_no_candidates', 'oversold_scanner_run', 'oversold_daily_scan'])
    .gte('created_at', since7d)
    .order('created_at', { ascending: false })
    .limit(15);

  console.log(`\n[4] SCANS DAILY oversold 7j : ${scanCount ?? 0}`);
  for (const s of scans ?? []) {
    const t = new Date(s.created_at as string).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`    ${t}  kind=? pf=${label(s.portfolio_id as string)}  ${s.summary?.slice(0, 80)}`);
  }

  // [5] Opens des derniers jours (proxy efficace du scanner 21:15)
  const { data: opens, count: openCount } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, portfolio_id, venue_fee_detail', { count: 'exact' })
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('entry_timestamp', since7d)
    .order('entry_timestamp', { ascending: false });

  console.log(`\n[5] OPENS scanner_oversold 7j : ${openCount ?? 0}`);
  const byDay = new Map<string, number>();
  for (const o of opens ?? []) {
    const day = String(o.entry_timestamp).slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  for (const [day, n] of [...byDay].sort((a, b) => b[0].localeCompare(a[0]))) {
    console.log(`    ${day}  → ${n} opens`);
  }

  // [6] Captures position_close_decisions des dernières 24h
  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count: caps24 } = await sb
    .from('position_close_decisions')
    .select('id', { count: 'exact', head: true })
    .gte('captured_at', since24);
  console.log(`\n[6] position_close_decisions captures 24h : ${caps24 ?? 0}`);

  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
