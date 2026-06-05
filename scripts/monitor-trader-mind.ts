/**
 * Watch live des décisions TRADER agent — 1 ligne par nouvelle décision.
 * À monter dans un Monitor tool pour stream temps réel.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER = 'b0000001-0000-0000-0000-000000000001';
const POLL_MS = 60_000;
const seen = new Set<string>();

async function pollOnce() {
  const since = new Date(Date.now() - 5 * 60_000).toISOString();
  try {
    const { data } = await sb
      .from('trader_agent_decisions')
      .select('id, decided_at, action_kind, action_applied, target_symbol, confidence, direction, notional_usd, thesis, gemini_provider, gemini_cost_usd, mistral_cost_usd, input_state')
      .eq('portfolio_id', TRADER)
      .gte('decided_at', since)
      .order('decided_at', { ascending: true });
    for (const d of data ?? []) {
      if (!d.id || seen.has(d.id)) continue;
      seen.add(d.id);
      const state = d.input_state as any;
      if (state?.cycle_tick_sentinel === true) continue; // skip cron pings
      const t = d.decided_at?.slice(11, 19) ?? '?';
      const ok = d.action_applied ? '✅' : '❌';
      const sym = d.target_symbol ?? '—';
      const conf = d.confidence != null ? Number(d.confidence).toFixed(2) : '—';
      const llm = d.gemini_provider ?? 'bypass';
      const cost = (Number(d.gemini_cost_usd ?? 0) + Number(d.mistral_cost_usd ?? 0)).toFixed(4);
      const thesis = (d.thesis ?? '').replace(/\n/g, ' ').slice(0, 90);
      console.log(`[TRADER MIND] ${t}Z ${ok} ${(d.action_kind ?? '?').padEnd(15)} ${sym.padEnd(12)} conf=${conf} LLM=${llm} cost=$${cost} | ${thesis}`);
    }
  } catch (e) {
    console.log(`[ERR poll] ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  // Bootstrap : ignore décisions des 5 dernières min
  const sinceBoot = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data } = await sb
    .from('trader_agent_decisions')
    .select('id')
    .eq('portfolio_id', TRADER)
    .gte('decided_at', sinceBoot);
  for (const d of data ?? []) if (d.id) seen.add(d.id);
  console.log(`[BOOT] ${seen.size} décisions déjà tracked. Polling chaque ${POLL_MS/1000}s...`);
  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
main().catch((e) => { console.log(`[FATAL] ${e}`); process.exit(1); });
