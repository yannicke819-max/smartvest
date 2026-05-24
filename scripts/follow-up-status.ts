/**
 * Suivi des positions ouvertes ce matin + nouveaux opens/closes depuis.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  // 1. Positions ouvertes — paper_trades (gainers simulées) + lisa_positions
  const { data: openPt } = await sb
    .from('paper_trades')
    .select('id, symbol, asset_class, side, entry_price, size_usd, opened_at, status, stop_loss, take_profit')
    .eq('status', 'open')
    .order('opened_at', { ascending: true });
  const { data: openLp } = await sb
    .from('lisa_positions')
    .select('id, symbol, asset_class, side, entry_price, qty, notional_usd, entry_timestamp, status, stop_loss, take_profit')
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: true });

  console.log(`\n=== paper_trades OUVERTES (${openPt?.length ?? 0}) ===`);
  for (const p of (openPt ?? [])) {
    const ageMin = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000);
    console.log(`  ${p.symbol.padEnd(10)} ${String(p.side).padEnd(5)} entry=${Number(p.entry_price).toFixed(4)} size=$${Number(p.size_usd).toFixed(0)} SL=${Number(p.stop_loss ?? 0).toFixed(4)} TP=${Number(p.take_profit ?? 0).toFixed(4)} age=${ageMin}min`);
  }
  console.log(`\n=== lisa_positions OUVERTES (${openLp?.length ?? 0}) ===`);
  for (const p of (openLp ?? [])) {
    const ageMin = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60_000);
    console.log(`  ${p.symbol.padEnd(10)} ${String(p.side).padEnd(5)} entry=${Number(p.entry_price).toFixed(4)} qty=${Number(p.qty).toFixed(4)} notional=$${Number(p.notional_usd).toFixed(0)} SL=${Number(p.stop_loss ?? 0).toFixed(4)} TP=${Number(p.take_profit ?? 0).toFixed(4)} age=${ageMin}min`);
  }

  // 2. Positions fermées aujourd'hui — paper_trades
  const { data: closedPt } = await sb
    .from('paper_trades')
    .select('symbol, asset_class, status, entry_price, exit_price, pnl_usd, pnl_pct, opened_at, closed_at')
    .neq('status', 'open')
    .gte('opened_at', todayStart.toISOString())
    .order('closed_at', { ascending: false });

  console.log(`\n=== paper_trades FERMÉES AUJOURD'HUI (${closedPt?.length ?? 0}) ===`);
  let pnlTotal = 0;
  for (const p of (closedPt ?? [])) {
    const ent = String(p.opened_at).slice(11, 16);
    const ext = p.closed_at ? String(p.closed_at).slice(11, 16) : '?';
    const usd = Number(p.pnl_usd ?? 0);
    const pct = Number(p.pnl_pct ?? 0);
    pnlTotal += usd;
    const sign = usd >= 0 ? '+' : '';
    console.log(`  ${ent}->${ext} ${p.symbol.padEnd(10)} ${p.status.padEnd(18)} pnl=${sign}${usd.toFixed(2)}$ (${sign}${pct.toFixed(2)}%)`);
  }
  console.log(`  Σ PnL realized today (paper_trades) = ${pnlTotal >= 0 ? '+' : ''}${pnlTotal.toFixed(2)} $`);

  // 3. PnL unrealized estimé pour les ouvertes — il faudrait les prix live (skip si pas dispo)
  // 4. Stats du flag US si activé : combien de US opens depuis ce matin ?
  const { data: usAccepts } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, asset_class, path_eff, persistence_score, cfg_min_path_eff, created_at')
    .gte('created_at', todayStart.toISOString())
    .eq('decision', 'accept')
    .or('asset_class.eq.us_equity_large,asset_class.eq.us_equity_small_mid')
    .order('created_at', { ascending: false });

  console.log(`\n=== US ACCEPTS depuis 00:00 UTC (${usAccepts?.length ?? 0}) — flag GAINERS_MIN_PATH_EFFICIENCY_US=0.4 ===`);
  for (const r of (usAccepts ?? [])) {
    const at = r.created_at.slice(11, 19);
    const inBand = Number(r.path_eff) >= 0.40 && Number(r.path_eff) < 0.50;
    console.log(`  ${at}  ${r.symbol.padEnd(8)} ${r.asset_class.padEnd(22)} pathEff=${Number(r.path_eff).toFixed(3)} [cfg min=${Number(r.cfg_min_path_eff).toFixed(2)}]${inBand ? '  ← BANDE [0.40-0.50] (nouveau grâce au flag)' : ''}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
