/**
 * "Esprit de décision TRADER" — vue minute par minute.
 * Affiche pour chaque cycle TRADER agent (toutes les 2 min) :
 *   - Heure
 *   - Nb candidats reçus
 *   - Action décidée + symbole
 *   - Confidence + thesis résumée
 *   - Applied (✅) ou rejected (❌)
 *   - LLM provider + coût
 *
 *   npx tsx scripts/trader-mind.ts [N=20]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const N = Number(process.argv[2] ?? 20);

  const { data } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, cycle_started_at, action_kind, action_applied, target_symbol, confidence, direction, notional_usd, thesis, apply_error, gemini_provider, gemini_cost_usd, mistral_cost_usd, input_candidates, input_state, input_macro, input_news_summary, input_memory_lessons')
    .eq('portfolio_id', TRADER)
    .order('decided_at', { ascending: false })
    .limit(N);

  console.log(`\n═══ Esprit décision TRADER — ${N} derniers cycles ═══\n`);

  for (const d of (data ?? []).reverse()) {
    const t = d.decided_at?.slice(11, 19) ?? '?';
    const action = d.action_kind ?? '?';
    const symbol = d.target_symbol ?? '—';
    const conf = d.confidence != null ? Number(d.confidence).toFixed(2) : '—';
    const dir = d.direction ?? '—';
    const notional = d.notional_usd ? `$${Number(d.notional_usd).toFixed(0)}` : '—';
    const applied = d.action_applied ? '✅' : '❌';
    const llm = d.gemini_provider ?? '—';
    const cost = (Number(d.gemini_cost_usd ?? 0) + Number(d.mistral_cost_usd ?? 0)).toFixed(4);

    // Input summary
    const candidates = Array.isArray(d.input_candidates) ? (d.input_candidates as any[]) : [];
    const candCount = candidates.length;
    const candTop = candidates.slice(0, 3).map(c => `${c.symbol ?? c.code ?? '?'}(${(c.change_pct ?? c.changePct ?? 0).toFixed(0)}%)`).join(',');

    // State
    const state = d.input_state as any;
    const openPositions = state?.openPositions?.length ?? state?.openCount ?? 0;
    const cyclePing = state?.cycle_tick_sentinel === true;

    // Macro
    const macro = d.input_macro as any;
    const regime = macro?.regime ?? macro?.macro_regime ?? '—';
    const vix = macro?.vix?.value ?? macro?.vix ?? '—';

    // Memory lessons
    const lessons = Array.isArray(d.input_memory_lessons) ? (d.input_memory_lessons as any[]).length : 0;

    // Thesis short
    const thesisShort = (d.thesis ?? '').replace(/\n/g, ' ').slice(0, 130);
    const apply = d.apply_error ? `⚠ ${d.apply_error.slice(0, 80)}` : '';

    if (cyclePing) {
      console.log(`${t}  ⊙ CYCLE_TICK  (cron ping, no real eval)`);
      continue;
    }

    console.log(`${t}  ${applied} ${action.padEnd(15)} sym=${symbol.padEnd(12)} dir=${dir.padEnd(5)} conf=${conf} notional=${notional}`);
    console.log(`         IN: cands=${candCount} (${candTop}) open=${openPositions} regime=${regime} vix=${vix} lessons=${lessons}`);
    console.log(`         LLM: ${llm} cost=$${cost}`);
    console.log(`         💭 ${thesisShort}`);
    if (apply) console.log(`         ${apply}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
