/**
 * Audit HIGH oversold scopé par UTC day — distingue "hier complet" vs
 * "aujourd'hui depuis 00:00 UTC". Fix : status réels sont closed_user/
 * closed_target/closed_invalidated/etc, pas littéralement "closed".
 *
 *   npx tsx scripts/audit-high-oversold-by-utc-day.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmtT(v: unknown) { return String(v ?? '').replace('T', ' ').slice(0, 16); }
function fmtUsd(n: unknown): string { const v = Number(n ?? 0); return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`; }

interface PosRow {
  symbol: string;
  entry_timestamp: string;
  exit_timestamp: string | null;
  entry_price: string;
  exit_price: string | null;
  realized_pnl_usd: number | null;
  realized_pnl_pct: number | null;
  exit_reason: string | null;
  venue_fee_detail: Record<string, unknown> | null;
  source: string | null;
  status: string;
}

async function fetchByEntry(from: string, to: string): Promise<PosRow[]> {
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, venue_fee_detail, source, status')
    .eq('portfolio_id', HIGH)
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('entry_timestamp', from)
    .lt('entry_timestamp', to)
    .order('entry_timestamp', { ascending: false });
  return (data ?? []) as unknown as PosRow[];
}

async function fetchByExit(from: string, to: string): Promise<PosRow[]> {
  const { data } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, realized_pnl_usd, realized_pnl_pct, exit_reason, venue_fee_detail, source, status')
    .eq('portfolio_id', HIGH)
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .like('status', 'closed%')
    .gte('exit_timestamp', from)
    .lt('exit_timestamp', to)
    .order('exit_timestamp', { ascending: false });
  return (data ?? []) as unknown as PosRow[];
}

function summarize(rows: PosRow[], label: string, opensView = false) {
  const opens = rows.length;
  const closed = rows.filter(p => p.status.startsWith('closed'));
  let sumPnl = 0, w = 0, l = 0;
  const byStatus = new Map<string, { n: number; pnl: number }>();
  for (const p of closed) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    sumPnl += pnl;
    if (pnl > 0) w++; else if (pnl < 0) l++;
    const s = String(p.status);
    const acc = byStatus.get(s) ?? { n: 0, pnl: 0 };
    acc.n++; acc.pnl += pnl;
    byStatus.set(s, acc);
  }
  const wr = w + l > 0 ? ((w / (w + l)) * 100).toFixed(0) : '–';
  const openNow = rows.filter(p => p.status === 'open').length;

  console.log(`\n┌─ ${label}`);
  console.log(`│ Positions tracées : ${opens}  (open=${openNow}, closed=${closed.length})`);
  if (closed.length > 0) {
    console.log(`│ Σ PnL réalisé      : $${fmtUsd(sumPnl)}`);
    console.log(`│ Win rate           : ${w}W / ${l}L (${wr}%)`);
    console.log(`│ Par status :`);
    for (const [s, { n, pnl }] of [...byStatus].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
      console.log(`│   ${pad(s, 22)} → n=${pad(n, 3)} Σ=$${fmtUsd(pnl)}`);
    }
  }
  if (rows.length > 0 && rows.length <= 40) {
    console.log(`│`);
    console.log(`│ Détail :`);
    console.log(`│   ${pad(opensView ? 'OPENED' : 'EXITED', 16)} ${pad('SYM', 10)} ${pad('PnL$', 8)} ${pad('PnL%', 7)} STATUS`);
    for (const p of rows) {
      const t = opensView ? p.entry_timestamp : (p.exit_timestamp ?? p.entry_timestamp);
      console.log(`│   ${fmtT(t)} ${pad(p.symbol, 10)} ${pad(fmtUsd(p.realized_pnl_usd), 8)} ${pad(`${Number(p.realized_pnl_pct ?? 0).toFixed(2)}%`, 7)} ${p.status}`);
    }
  }
  console.log(`└─`);
  return { opens, closed: closed.length, sumPnl, w, l };
}

async function main() {
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const yUTC = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);

  const todayStart = `${todayUTC}T00:00:00Z`;
  const yStart = `${yUTC}T00:00:00Z`;
  const tomorrowStart = new Date(new Date(todayStart).getTime() + 86400_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(` AUDIT HIGH oversold scopé UTC day @ ${now.toISOString().slice(0,19)}Z`);
  console.log(`   AUJOURD'HUI UTC : ${todayUTC}  (Paris start ${new Date(todayStart).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })})`);
  console.log(`   HIER UTC        : ${yUTC}  (Paris start ${new Date(yStart).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })})`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  const opensToday = await fetchByEntry(todayStart, tomorrowStart);
  const yT = summarize(opensToday, `OUVERTURES AUJOURD'HUI UTC (${todayUTC})`, true);

  const opensY = await fetchByEntry(yStart, todayStart);
  const oY = summarize(opensY, `OUVERTURES HIER UTC (${yUTC}, journée complète)`, true);

  const closesToday = await fetchByExit(todayStart, tomorrowStart);
  const cT = summarize(closesToday, `FERMETURES AUJOURD'HUI UTC (${todayUTC})`);

  const closesY = await fetchByExit(yStart, todayStart);
  const cY = summarize(closesY, `FERMETURES HIER UTC (${yUTC}, journée complète)`);

  // Still open as of NOW
  const { data: stillOpenData } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, entry_price, exit_reason, venue_fee_detail, source, status')
    .eq('portfolio_id', HIGH)
    .eq('status', 'open')
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .order('entry_timestamp', { ascending: false });
  console.log(`\n┌─ STILL OPEN scanner_oversold MAINTENANT : ${stillOpenData?.length ?? 0}`);
  for (const p of (stillOpenData ?? [])) {
    const ageH = ((Date.now() - new Date(String(p.entry_timestamp)).getTime()) / 3600_000).toFixed(1);
    console.log(`│   ${fmtT(p.entry_timestamp)} ${pad(p.symbol, 10)} entry=$${Number(p.entry_price).toFixed(2)} age=${ageH}h`);
  }
  console.log(`└─`);

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SYNTHÈSE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(` Hier UTC (${yUTC})      : ${oY.opens} opens, ${cY.closed} closes, Σ PnL $${fmtUsd(cY.sumPnl)}, WR ${cY.w}W/${cY.l}L`);
  console.log(` Aujourd'hui UTC (${todayUTC}) : ${yT.opens} opens, ${cT.closed} closes, Σ PnL $${fmtUsd(cT.sumPnl)}, WR ${cT.w}W/${cT.l}L`);
  console.log(` Encore ouvertes        : ${stillOpenData?.length ?? 0}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
