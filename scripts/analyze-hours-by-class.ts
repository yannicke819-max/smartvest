/**
 * Analyse WR / sum PnL par heure UTC × asset_class historique.
 * Objectif : valider/raffiner le hour blacklist actuel ({0,1,2,3,4,8,19,22,23}).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: opens } = await sb
    .from('top_gainers_log')
    .select('symbol, detected_asset_class, opened_position_id, captured_at')
    .eq('decision', 'opened')
    .not('opened_position_id', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(2000);
  if (!opens) return;

  const ids = (opens as Array<{ opened_position_id: string | null }>).map((r) => r.opened_position_id).filter((x): x is string => !!x);
  const { data: closed } = await sb
    .from('lisa_positions')
    .select('id, realized_pnl_pct, realized_pnl_usd, status, entry_timestamp')
    .in('id', ids)
    .neq('status', 'open');
  const closedMap = new Map<string, { pnl_pct: number; pnl_usd: number; ts: string }>();
  for (const c of (closed ?? []) as Array<{ id: string; realized_pnl_pct: number | null; realized_pnl_usd: number | null; entry_timestamp: string }>) {
    if (c.realized_pnl_usd != null && c.entry_timestamp) {
      closedMap.set(c.id, { pnl_pct: Number(c.realized_pnl_pct ?? 0), pnl_usd: Number(c.realized_pnl_usd), ts: c.entry_timestamp });
    }
  }

  const joined: Array<{ class: string; hour: number; pnl_pct: number; pnl_usd: number }> = [];
  for (const o of opens as Array<{ detected_asset_class: string | null; opened_position_id: string | null }>) {
    if (!o.opened_position_id) continue;
    const c = closedMap.get(o.opened_position_id);
    if (!c) continue;
    const h = Number.parseInt(c.ts.slice(11, 13), 10);
    if (!Number.isFinite(h)) continue;
    joined.push({ class: o.detected_asset_class ?? 'unknown', hour: h, pnl_pct: c.pnl_pct, pnl_usd: c.pnl_usd });
  }

  console.log(`\n=== ${joined.length} trades fermés avec entry_hour_utc ===\n`);

  const classes = ['asia_equity', 'eu_equity', 'us_equity_large', 'us_equity_small_mid', 'crypto_major'];
  for (const cls of classes) {
    const sub = joined.filter((j) => j.class === cls);
    if (sub.length < 10) {
      console.log(`\n--- ${cls} (n=${sub.length}) → skip ---`);
      continue;
    }
    console.log(`\n--- ${cls} (n=${sub.length}) ---`);
    console.log('Hour | n   | WR%  | mean_pnl%  | sum_$');
    for (let h = 0; h < 24; h++) {
      const band = sub.filter((j) => j.hour === h);
      if (band.length < 3) continue;
      const winners = band.filter((b) => b.pnl_usd > 0).length;
      const meanPct = band.reduce((s, b) => s + b.pnl_pct, 0) / band.length;
      const sumUsd = band.reduce((s, b) => s + b.pnl_usd, 0);
      const wr = Math.round((winners * 100) / band.length);
      const flag = sumUsd >= 0 && wr >= 50 ? ' ✅' : sumUsd <= -20 ? ' ❌' : '';
      console.log(`${String(h).padStart(2)}h  | ${String(band.length).padStart(3)} | ${String(wr).padStart(3)}% | ${(meanPct >= 0 ? '+' : '')}${meanPct.toFixed(3)}%  | ${sumUsd >= 0 ? '+' : ''}$${sumUsd.toFixed(2)}${flag}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
