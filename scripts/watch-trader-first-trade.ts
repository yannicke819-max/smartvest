/**
 * Watch — premier trade ouvert sur portfolio TRADER (b0000001).
 *
 * Polls toutes les 30s. Exit dès qu'une position est ouverte sur b0000001
 * (status='open' ou position_opened event). Timeout 4h (= jusqu'à 13:30 UTC
 * approx pour couvrir la fenêtre EU + premiers candidats US).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER = 'b0000001-0000-0000-0000-000000000001';
const startTs = new Date().toISOString();

async function check(): Promise<{ found: boolean; details?: string }> {
  // 1. Positions ouvertes sur TRADER depuis startTs
  const { data: pos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, entry_notional_usd, direction, entry_price')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', startTs).limit(5);
  if (pos && pos.length > 0) {
    const p: any = pos[0];
    return {
      found: true,
      details: `${p.symbol} ${p.direction} ${p.status} entry=$${p.entry_price} $${p.entry_notional_usd} @ ${p.entry_timestamp?.slice(11,19)} UTC`,
    };
  }

  // 2. position_opened event TRADER (au cas où DB timing decalé)
  const { data: ev } = await sb.from('lisa_decision_log')
    .select('timestamp, summary')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'position_opened')
    .gte('timestamp', startTs).limit(5);
  if (ev && ev.length > 0) {
    return { found: true, details: `event @ ${ev[0].timestamp.slice(11,19)} : ${ev[0].summary?.slice(0, 100)}` };
  }

  return { found: false };
}

async function tickPing(): Promise<void> {
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  // Activité TRADER 5min
  const { data: tad } = await sb.from('trader_agent_decisions')
    .select('decided_at, action_kind, target_symbol, thesis')
    .gte('decided_at', since)
    .order('decided_at', { ascending: false }).limit(3);
  const actionnables = (tad ?? []).filter((t: any) => t.action_kind !== 'hold');
  const latest = (tad ?? [])[0] as any;
  const latestThesis = latest?.thesis?.slice(0, 80) ?? 'n/a';
  console.log(`  [tick] last_action=${latest?.action_kind ?? 'none'} sym=${latest?.target_symbol ?? '-'} | actionnables_5min=${actionnables.length} | "${latestThesis}"`);
}

(async () => {
  console.log(`Watch TRADER first trade — start ${startTs}`);
  console.log(`Target: portfolio b0000001, polling 30s, timeout 4h\n`);
  const deadline = Date.now() + 4 * 60 * 60_000;
  while (Date.now() < deadline) {
    const now = new Date().toISOString();
    const res = await check();
    if (res.found) {
      console.log(`\n🎉 [${now.slice(11,19)}] PREMIER TRADE TRADER DETECTED:`);
      console.log(`   ${res.details}`);
      console.log('\n=== EXIT — watch terminé ===');
      process.exit(0);
    }
    console.log(`[${now.slice(11,19)}] no trade yet`);
    await tickPing();
    await new Promise(r => setTimeout(r, 30_000));
  }
  console.log('\n=== TIMEOUT 4h — aucun trade TRADER détecté ===');
  process.exit(0);
})();
