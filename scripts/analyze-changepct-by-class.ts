/**
 * Analyse le WR / mean PnL par bande changePct × asset_class historique.
 * Objectif : calibrer le seuil "anti chase-the-top" per-class.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Pull all closed positions with their change_pct@entry (from top_gainers_log via opened_position_id)
  const { data: opens, error } = await sb
    .from('top_gainers_log')
    .select('symbol, change_pct, detected_asset_class, opened_position_id')
    .eq('decision', 'opened')
    .not('opened_position_id', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(2000);
  if (error) { console.error(error); return; }
  if (!opens) return;

  const ids = opens.map((r) => r.opened_position_id).filter((x): x is string => !!x);
  const { data: closed } = await sb
    .from('lisa_positions')
    .select('id, realized_pnl_pct, realized_pnl_usd, status')
    .in('id', ids)
    .neq('status', 'open');

  const closedMap = new Map<string, { pnl_pct: number | null; pnl_usd: number | null }>();
  for (const c of (closed ?? []) as Array<{ id: string; realized_pnl_pct: number | null; realized_pnl_usd: number | null }>) {
    closedMap.set(c.id, { pnl_pct: c.realized_pnl_pct, pnl_usd: c.realized_pnl_usd });
  }

  const joined: Array<{ class: string; ch: number; pnl_pct: number; pnl_usd: number }> = [];
  for (const o of opens as Array<{ change_pct: number | null; detected_asset_class: string | null; opened_position_id: string | null }>) {
    if (!o.opened_position_id) continue;
    const c = closedMap.get(o.opened_position_id);
    if (!c || c.pnl_pct == null) continue;
    joined.push({
      class: o.detected_asset_class ?? 'unknown',
      ch: Number(o.change_pct ?? 0),
      pnl_pct: Number(c.pnl_pct),
      pnl_usd: Number(c.pnl_usd ?? 0),
    });
  }

  console.log(`\n=== ${joined.length} trades fermés avec change_pct@entry ===\n`);

  // Group per class
  const classes = new Set(joined.map((j) => j.class));
  for (const cls of Array.from(classes).sort()) {
    const subset = joined.filter((j) => j.class === cls);
    if (subset.length < 5) continue;
    console.log(`\n--- ${cls} (n=${subset.length}) ---`);
    // Bands
    const bands: Array<[number, number, string]> = [
      [0, 5, '[0-5%]'],
      [5, 7.5, '[5-7.5%]'],
      [7.5, 10, '[7.5-10%]'],
      [10, 15, '[10-15%]'],
      [15, 20, '[15-20%]'],
      [20, 30, '[20-30%]'],
      [30, 1e9, '[30%+]'],
    ];
    for (const [lo, hi, lbl] of bands) {
      const band = subset.filter((j) => j.ch >= lo && j.ch < hi);
      if (band.length < 3) {
        if (band.length > 0) console.log(`  ${lbl.padEnd(12)} n=${band.length} (small sample, skipped)`);
        continue;
      }
      const winners = band.filter((b) => b.pnl_usd > 0).length;
      const meanPct = band.reduce((s, b) => s + b.pnl_pct, 0) / band.length;
      const sumUsd = band.reduce((s, b) => s + b.pnl_usd, 0);
      console.log(`  ${lbl.padEnd(12)} n=${String(band.length).padStart(3)}  WR=${Math.round((winners*100)/band.length).toString().padStart(3)}%  mean_pnl=${meanPct >= 0 ? '+' : ''}${meanPct.toFixed(3)}%  sum=${sumUsd >= 0 ? '+' : ''}$${sumUsd.toFixed(2)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
