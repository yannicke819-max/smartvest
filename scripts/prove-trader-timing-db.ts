/**
 * Prove TRADER entry timing using ONLY data already in Supabase (no external API).
 * Sources :
 *   - top_gainers_log : snapshot scanner per cycle (close_price, high_price, changePct)
 *   - lisa_positions : entry_price + TP/SL + horodatage
 *   - gainers_user_shadow_signals : decisions scanner par cycle (path_eff, persistence)
 *   - trader_agent_decisions : ce que Mistral voyait et a décidé
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';

async function analyzePosition(p: any): Promise<void> {
  const entryPrice = Number(p.entry_price);
  const tp = Number(p.take_profit_price);
  const sl = Number(p.stop_loss_price);
  const entryTs = new Date(p.entry_timestamp).getTime();
  const ageMin = (Date.now() - entryTs) / 60_000;

  console.log(`\n━━━ ${p.symbol} (${p.direction}) ━━━`);
  console.log(`  Entry   : $${entryPrice.toFixed(4)} @ ${p.entry_timestamp.slice(11, 19)} UTC (il y a ${ageMin.toFixed(1)}min)`);
  console.log(`  TP/SL   : $${tp.toFixed(4)} (+${(((tp - entryPrice) / entryPrice) * 100).toFixed(2)}%) / $${sl.toFixed(4)} (${(((sl - entryPrice) / entryPrice) * 100).toFixed(2)}%)`);

  // 1. ENTRY CONTEXT : ce que voyait le scanner T-15min → T+15min
  const since = new Date(entryTs - 30 * 60_000).toISOString();
  const until = new Date(Math.min(Date.now(), entryTs + 90 * 60_000)).toISOString();
  const { data: snaps }: any = await sb.from('top_gainers_log')
    .select('captured_at, close_price, high_price, change_pct, volume, score, decision')
    .eq('symbol', p.symbol)
    .gte('captured_at', since).lte('captured_at', until)
    .order('captured_at', { ascending: true });

  if (!snaps?.length) {
    console.log(`  ⚠️ Aucun snapshot top_gainers_log autour de l'entrée`);
    return;
  }

  console.log(`\n  📊 Path scanner snapshots (T-30min → T+90min) — ${snaps.length} ticks :`);
  console.log(`  time      close_px     vs_entry   high_px      changePct   decision`);
  let preMaxHigh = 0, preMinClose = Infinity, postMaxHigh = 0, postMinLow = Infinity;
  let mfeClose = -Infinity, maeClose = Infinity;
  for (const s of snaps) {
    const ts = new Date(s.captured_at).getTime();
    const isEntry = Math.abs(ts - entryTs) < 60_000;
    const isPost = ts >= entryTs;
    const cp = Number(s.close_price);
    const hp = Number(s.high_price);
    const vsEntry = ((cp - entryPrice) / entryPrice) * 100;
    if (!isPost) {
      preMaxHigh = Math.max(preMaxHigh, hp);
      preMinClose = Math.min(preMinClose, cp);
    } else {
      postMaxHigh = Math.max(postMaxHigh, hp);
      postMinLow = Math.min(postMinLow, cp);
      mfeClose = Math.max(mfeClose, cp);
      maeClose = Math.min(maeClose, cp);
    }
    const arrow = isEntry ? '→ ENTRY' : isPost ? '   post' : '   pre';
    console.log(`  ${String(s.captured_at).slice(11, 19)}  $${cp.toFixed(2).padStart(8)}  ${vsEntry >= 0 ? '+' : ''}${vsEntry.toFixed(2).padStart(6)}%   $${hp.toFixed(2).padStart(8)}   ${String(s.change_pct ?? '').padEnd(7)}   ${String(s.decision ?? '').padEnd(10)}  ${arrow}`);
  }

  // 2. VERDICT TIMING
  console.log(`\n  🎯 VERDICT TIMING :`);
  if (preMaxHigh > 0 && preMaxHigh < Infinity) {
    const vsPreHigh = ((entryPrice - preMaxHigh) / preMaxHigh) * 100;
    console.log(`     Pre-entry HIGH (T-30min) : $${preMaxHigh.toFixed(4)} → entry @ $${entryPrice.toFixed(4)} = ${vsPreHigh >= 0 ? '+' : ''}${vsPreHigh.toFixed(2)}%`);
    if (vsPreHigh > 0.5) console.log(`       ⚠️  AU-DESSUS du peak récent — risque FOMO entry`);
    else if (vsPreHigh < -1) console.log(`       ✅ EN PULLBACK depuis le peak — bon timing`);
    else console.log(`       ➖ proche du peak (±1%) — timing acceptable`);
  }
  if (postMaxHigh > 0) {
    const mfePct = ((postMaxHigh - entryPrice) / entryPrice) * 100;
    const maePct = ((postMinLow - entryPrice) / entryPrice) * 100;
    const tpPct = ((tp - entryPrice) / entryPrice) * 100;
    const slPct = ((sl - entryPrice) / entryPrice) * 100;
    const maeRatio = Math.abs(maePct) / Math.abs(slPct);
    console.log(`     Post-entry MFE : +${mfePct.toFixed(2)}% (best favorable) ${mfePct >= tpPct ? '→ TP DÉJÀ TOUCHÉ ✅' : mfePct >= tpPct * 0.5 ? `→ ${((mfePct/tpPct)*100).toFixed(0)}% chemin TP` : ''}`);
    console.log(`     Post-entry MAE : ${maePct.toFixed(2)}% (worst adverse) ${maePct <= slPct ? '→ SL DÉJÀ TOUCHÉ ⚠️' : ''}`);
    console.log(`     MAE/R          : ${maeRatio.toFixed(2)} ${maeRatio < 0.3 ? '✅ EXCELLENT (entrée propre, peu de stress)' : maeRatio < 0.6 ? '➖ OK' : maeRatio < 1 ? '⚠️ marginal' : '❌ entry au peak, stop stressé'}`);
  }

  // 3. CONTEXT MISTRAL
  const { data: mistralDec }: any = await sb.from('trader_agent_decisions')
    .select('decided_at, thesis, confidence, gemini_provider')
    .eq('target_symbol', p.symbol).gte('decided_at', since).lte('decided_at', until)
    .order('decided_at', { ascending: true });
  if (mistralDec?.length) {
    console.log(`\n  🤖 MISTRAL decisions sur ${p.symbol} :`);
    for (const d of mistralDec) {
      console.log(`     ${d.decided_at.slice(11, 19)} conf=${d.confidence ?? '-'} prov=${d.gemini_provider}`);
      console.log(`       "${String(d.thesis ?? '').slice(0, 200)}"`);
    }
  }
}

(async () => {
  console.log(`\n========== PROVE TRADER TIMING — ${new Date().toISOString()} ==========`);
  const { data: positions }: any = await sb.from('lisa_positions')
    .select('id, symbol, entry_price, entry_timestamp, take_profit_price, stop_loss_price, direction')
    .eq('portfolio_id', TRADER).eq('status', 'open')
    .order('entry_timestamp', { ascending: true });
  console.log(`Positions ouvertes : ${positions?.length ?? 0}`);
  for (const p of positions ?? []) await analyzePosition(p);
  console.log(`\n========== END ==========\n`);
})();
