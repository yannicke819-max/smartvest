import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const HIGH = 'a0000001-0000-0000-0000-000000000001';
function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number | null, d = 2): string { return n == null ? 'n/a' : Number(n).toFixed(d); }

async function main() {
  // Load ALL positions (open + closed) on HIGH 04/06 with source=scanner_oversold
  const { data: all } = await sb
    .from('lisa_positions')
    .select('symbol, entry_timestamp, exit_timestamp, entry_price, exit_price, status, realized_pnl_pct')
    .eq('portfolio_id', HIGH)
    .filter('venue_fee_detail->>source', 'eq', 'scanner_oversold')
    .gte('entry_timestamp', '2026-06-04T00:00:00Z')
    .lt('entry_timestamp', '2026-06-05T00:00:00Z')
    .order('entry_timestamp', { ascending: true });

  if (!all?.length) return;

  // Group by symbol → chronological events
  type Event = { ts: string; type: 'entry' | 'exit'; price: number; status?: string; pnl?: number | null };
  const bySymbol = new Map<string, Event[]>();
  for (const p of all as any[]) {
    const arr = bySymbol.get(p.symbol) ?? [];
    arr.push({ ts: p.entry_timestamp, type: 'entry', price: parseFloat(p.entry_price), status: p.status });
    if (p.exit_timestamp && p.exit_price) {
      arr.push({ ts: p.exit_timestamp, type: 'exit', price: parseFloat(p.exit_price), status: p.status, pnl: p.realized_pnl_pct });
    }
    bySymbol.set(p.symbol, arr);
  }
  for (const [, arr] of bySymbol) arr.sort((a, b) => a.ts.localeCompare(b.ts));

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' LABELER via re-ouvertures successives (proxy intraday trajectory)');
  console.log(' Pour chaque user_close, regarde le prochain event sur ce symbole pour mesurer la suite.');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');
  console.log(pad('SYM', 10), pad('EXIT_T', 6), pad('EXIT$', 8), pad('NEXT_T', 6), pad('NEXT$', 8), pad('ΔT', 6), pad('Δ%', 8), pad('LABEL', 10));

  const labels = new Map<string, number>();
  let sumExtra = 0;
  let countWithData = 0;
  const earlyDetails: Array<{ sym: string; t: string; deltaMin: number; extraPct: number }> = [];

  for (const [symbol, events] of bySymbol) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type !== 'exit' || e.status !== 'closed_user') continue;
      const nextEvent = events[i + 1];
      const t = String(e.ts).slice(11, 16);
      if (!nextEvent) {
        console.log(pad(symbol, 10), pad(t, 6), pad(fmt(e.price), 8), pad('—', 6), pad('—', 8), pad('—', 6), pad('—', 8), pad('NO_NEXT', 10));
        continue;
      }
      const exitMs = new Date(e.ts).getTime();
      const nextMs = new Date(nextEvent.ts).getTime();
      const deltaMin = Math.round((nextMs - exitMs) / 60_000);
      const deltaPct = ((nextEvent.price - e.price) / e.price) * 100;

      let label: string;
      // Positive delta = price kept going UP after your close = you closed early
      if (deltaPct >= 1.0) { label = '🔴 EARLY'; earlyDetails.push({ sym: symbol, t, deltaMin, extraPct: deltaPct }); }
      else if (deltaPct >= 0.3) label = '🟡 OK';
      else if (deltaPct >= -0.3) label = '🟢 GOOD';
      else label = '🟢 GOOD-'; // price dropped after close = perfect timing
      const labelKey = label.split(' ')[1];
      labels.set(labelKey, (labels.get(labelKey) ?? 0) + 1);
      sumExtra += deltaPct;
      countWithData++;

      const nextT = String(nextEvent.ts).slice(11, 16);
      console.log(pad(symbol, 10), pad(t, 6), pad(fmt(e.price), 8), pad(nextT, 6), pad(fmt(nextEvent.price), 8), pad(`${deltaMin}m`, 6), pad(`${deltaPct.toFixed(2)}%`, 8), pad(label, 10));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log(' SYNTHÈSE');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  for (const [l, n] of [...labels].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(l, 8)} : ${n} (${((n / countWithData) * 100).toFixed(0)}%)`);
  }
  if (countWithData > 0) {
    console.log(`\n  Avg Δ% post-close   : ${(sumExtra / countWithData).toFixed(2)}%`);
    console.log(`     (positif = tu fermes alors que le rebond continue, négatif = parfait)`);
  }
  if (earlyDetails.length > 0) {
    console.log(`\n  TOP closes EARLY (tu as fermé trop tôt) :`);
    for (const d of earlyDetails.sort((a, b) => b.extraPct - a.extraPct).slice(0, 8)) {
      console.log(`    ${d.sym.padEnd(10)} ${d.t} → +${d.extraPct.toFixed(2)}% en ${d.deltaMin}min après ton close`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
