/**
 * Post-mortem : entre 08:25 (open SOL/ETH/XRP) et 14:17 UTC (cascade SL),
 * quels signaux DÉJÀ EN DB auraient pu prédire la mort du pump ?
 *
 * Hypothèses à tester :
 *  H1 : persistence multi-TF s'est dégradée avant les SL
 *  H2 : pathEff a chuté avant les SL
 *  H3 : BTC a commencé à baisser avant que SOL/ETH ne SL (effet cascade)
 *  H4 : volume / change_pct_1m a perdu son momentum sur les rescans
 *  H5 : EVENT-NARRATIVE — y a-t-il eu une news / event économique pendant la fenêtre ?
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const WINDOW_START = '2026-05-24T08:00:00Z';
const WINDOW_END   = '2026-05-24T14:30:00Z';
const SYMS = ['SOLUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'BTCUSDT'];

async function main() {
  // H1 + H2 + H4 — Toutes les apparitions de ces symboles dans gainers_user_shadow_signals
  // entre 08:00 et 14:30 UTC. accept OU reject — on veut voir l'évolution.
  const { data: signals } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, decision, path_eff, persistence_score, persistence_count, change_pct_1m, created_at')
    .gte('created_at', WINDOW_START)
    .lte('created_at', WINDOW_END)
    .in('symbol', SYMS)
    .order('created_at', { ascending: true });

  console.log(`\n=== H1+H2+H4 : Évolution des signals (${signals?.length ?? 0} apparitions) ===\n`);
  for (const sym of SYMS) {
    const rows = (signals ?? []).filter(r => r.symbol === sym);
    if (rows.length === 0) continue;
    console.log(`  --- ${sym} (${rows.length} apparitions) ---`);
    for (const r of rows) {
      const at = r.created_at.slice(11, 19);
      const eff = r.path_eff != null ? Number(r.path_eff).toFixed(3) : ' n/a ';
      const persist = r.persistence_count ?? '-';
      const score = r.persistence_score != null ? Number(r.persistence_score).toFixed(2) : 'n/a';
      const ch = r.change_pct_1m != null ? `${Number(r.change_pct_1m).toFixed(2)}%` : 'n/a';
      console.log(`    ${at}  ${String(r.decision).padEnd(22)}  pathEff=${eff}  persist=${String(persist).padEnd(4)} (${score})  ch1m=${ch}`);
    }
    console.log('');
  }

  // H5 — Y a-t-il des news / event économiques dans la fenêtre ?
  console.log(`\n=== H5 : News / events économiques durant la fenêtre ===\n`);
  const tables = ['eodhd_news_persisted', 'eodhd_economic_events', 'gemini_daily_catalyst_brief', 'eodhd_news', 'economic_events'];
  for (const tbl of tables) {
    const { data, error } = await sb.from(tbl).select('*').gte('published_at', WINDOW_START).lte('published_at', WINDOW_END).limit(20);
    if (error) {
      // Try alternate timestamp column
      const { data: d2, error: e2 } = await sb.from(tbl).select('*').gte('created_at', WINDOW_START).lte('created_at', WINDOW_END).limit(20);
      if (e2) { console.log(`  ${tbl} : ${error.message}`); continue; }
      console.log(`  ${tbl} : ${d2?.length ?? 0} rows (via created_at)`);
      for (const r of (d2 ?? []).slice(0, 5)) console.log(`    `, JSON.stringify(r).slice(0, 300));
    } else {
      console.log(`  ${tbl} : ${data?.length ?? 0} rows`);
      for (const r of (data ?? []).slice(0, 5)) console.log(`    `, JSON.stringify(r).slice(0, 300));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
