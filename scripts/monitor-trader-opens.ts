/**
 * Watch loop : émet 1 ligne par nouvelle position ouverte sur TRADER.
 * Tourne en boucle 60s. Sortie = chaque ligne devient une notification.
 *
 *   npx tsx scripts/monitor-trader-opens.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER_PORTFOLIO = 'b0000001-0000-0000-0000-000000000001';
const POLL_INTERVAL_MS = 60_000;
const seen = new Set<string>();

async function pollOnce() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  try {
    const { data, error } = await sb
      .from('lisa_positions')
      .select('id, symbol, venue, direction, entry_price, entry_notional_usd, entry_timestamp, status')
      .eq('portfolio_id', TRADER_PORTFOLIO)
      .gte('entry_timestamp', since)
      .order('entry_timestamp', { ascending: false });
    if (error) {
      console.log(`[ERR poll] ${error.message}`);
      return;
    }
    for (const p of data ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const ts = p.entry_timestamp ? p.entry_timestamp.slice(11, 19) : '?';
      console.log(`[TRADER OPEN] ${ts}Z ${p.symbol} (${p.venue ?? '?'}) ${p.direction} entry=$${Number(p.entry_price ?? 0).toFixed(2)} notional=$${Number(p.entry_notional_usd ?? 0).toFixed(0)} status=${p.status}`);
    }
  } catch (e) {
    console.log(`[ERR poll catch] ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  // Bootstrap : ignore positions déjà ouvertes
  const sinceBoot = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: existing } = await sb
    .from('lisa_positions')
    .select('id')
    .eq('portfolio_id', TRADER_PORTFOLIO)
    .gte('entry_timestamp', sinceBoot);
  for (const p of existing ?? []) seen.add(p.id);
  console.log(`[BOOT] ${seen.size} positions TRADER déjà tracked (ignorées). Polling toutes les ${POLL_INTERVAL_MS/1000}s...`);

  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
main().catch((e) => { console.log(`[FATAL] ${e}`); process.exit(1); });
