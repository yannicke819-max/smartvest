/**
 * Audit complet EU sur TRADER — 24h.
 *
 * Sections :
 * 1. Funnel shadow signals EU
 * 2. Scanner_proposals EU (scores, status)
 * 3. Positions EU ouvertes/fermées (PnL, durée, raison de close)
 * 4. Bypass HIGH_CONVICTION events
 * 5. Skip events EU (gates qui bloquent encore)
 * 6. Top tickers EU performants/perdants
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER = 'b0000001-0000-0000-0000-000000000001';
const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
const sinceNow = new Date(Date.now() - 60 * 60_000).toISOString();

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(` AUDIT EU TRADER — ${new Date().toISOString().slice(0,19)} UTC`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  // 1. FUNNEL SHADOW SIGNALS EU 24h
  console.log(`──── 1. FUNNEL SHADOW SIGNALS EU 24h ────\n`);
  const { data: shadow } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, decision, created_at, entry_price')
    .eq('asset_class', 'eu_equity')
    .gte('created_at', since24h);
  const decisions = new Map<string, number>();
  for (const s of shadow ?? []) {
    decisions.set(s.decision, (decisions.get(s.decision) ?? 0) + 1);
  }
  const total = shadow?.length ?? 0;
  const accept = decisions.get('accept') ?? 0;
  console.log(`Total signaux scannés : ${total}`);
  console.log(`Accept : ${accept} (${total > 0 ? (accept/total*100).toFixed(0) : 0}%)`);
  console.log(`\nRejets :`);
  for (const [d, n] of [...decisions].filter(([d]) => d !== 'accept').sort((a,b) => b[1]-a[1])) {
    console.log(`  ${d.padEnd(30)} : ${n} (${(n/total*100).toFixed(1)}%)`);
  }

  // 2. SCANNER_PROPOSALS EU 24h — distribution scores
  console.log(`\n──── 2. SCANNER_PROPOSALS EU 24h ────\n`);
  const { data: proposals } = await sb
    .from('scanner_proposals')
    .select('symbol, score, change_pct, status, created_at, expires_at')
    .eq('portfolio_id', TRADER)
    .eq('asset_class', 'eu_equity')
    .gte('created_at', since24h);
  const totalProps = proposals?.length ?? 0;
  console.log(`Total proposals générés : ${totalProps}`);
  const buckets = { high: 0, medium: 0, low: 0 };
  const scoresUniqSyms = new Map<string, { maxScore: number; count: number }>();
  for (const p of proposals ?? []) {
    const s = Number(p.score ?? 0);
    if (s >= 0.7) buckets.high++;
    else if (s >= 0.35) buckets.medium++;
    else buckets.low++;
    const acc = scoresUniqSyms.get(p.symbol) ?? { maxScore: 0, count: 0 };
    acc.maxScore = Math.max(acc.maxScore, s);
    acc.count++;
    scoresUniqSyms.set(p.symbol, acc);
  }
  console.log(`Score ≥ 0.7  (high bypass)      : ${buckets.high} (${totalProps > 0 ? (buckets.high/totalProps*100).toFixed(0) : 0}%)`);
  console.log(`Score 0.35-0.7 (bypass actuel)  : ${buckets.medium} (${totalProps > 0 ? (buckets.medium/totalProps*100).toFixed(0) : 0}%)`);
  console.log(`Score < 0.35 (LLM decides)       : ${buckets.low} (${totalProps > 0 ? (buckets.low/totalProps*100).toFixed(0) : 0}%)`);
  console.log(`Unique symbols : ${scoresUniqSyms.size}`);

  // 3. POSITIONS EU 24h
  console.log(`\n──── 3. POSITIONS EU 24h ────\n`);
  const { data: positions } = await sb
    .from('lisa_positions')
    .select('symbol, asset_class, status, entry_price, exit_price, entry_timestamp, exit_timestamp, realized_pnl_usd, realized_pnl_pct, exit_reason, entry_notional_usd')
    .eq('portfolio_id', TRADER)
    .gte('entry_timestamp', since24h)
    .or('asset_class.eq.eu_equity,symbol.like.%.LSE,symbol.like.%.XETRA,symbol.like.%.PA,symbol.like.%.AS,symbol.like.%.SW');
  let totalPnl = 0, opens = 0, closes = 0, wins = 0, losses = 0;
  const closeReasons = new Map<string, number>();
  console.log(`Total positions EU : ${positions?.length ?? 0}`);
  for (const p of positions ?? []) {
    if (p.status === 'open') opens++;
    else {
      closes++;
      const pnl = Number(p.realized_pnl_usd ?? 0);
      totalPnl += pnl;
      if (pnl > 0) wins++; else losses++;
      const status = p.status ?? 'unknown';
      closeReasons.set(status, (closeReasons.get(status) ?? 0) + 1);
    }
  }
  console.log(`  Open       : ${opens}`);
  console.log(`  Closed     : ${closes} (W:${wins} L:${losses})`);
  console.log(`  WinRate    : ${closes > 0 ? (wins/closes*100).toFixed(0) : 0}%`);
  console.log(`  Sum PnL    : $${totalPnl.toFixed(2)}`);
  console.log(`\nClose reasons :`);
  for (const [r, n] of [...closeReasons].sort((a,b) => b[1]-a[1])) {
    console.log(`  ${r.padEnd(25)} : ${n}`);
  }
  console.log(`\nDétail positions :`);
  for (const p of (positions ?? []).slice(0, 20)) {
    const pnl = Number(p.realized_pnl_usd ?? 0);
    const pnlPct = Number(p.realized_pnl_pct ?? 0);
    const dur = p.exit_timestamp ? Math.round((new Date(p.exit_timestamp).getTime() - new Date(p.entry_timestamp).getTime()) / 60_000) : 0;
    console.log(`  ${p.entry_timestamp.slice(0,16)} ${p.symbol.padEnd(14)} ${p.status.padEnd(20)} entry=$${Number(p.entry_price).toFixed(2)} exit=${p.exit_price ? `$${Number(p.exit_price).toFixed(2)}` : '—'} pnl=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) dur=${dur}min reason=${(p.exit_reason ?? '').slice(0, 50)}`);
  }

  // 4. BYPASS HIGH_CONVICTION events EU 24h
  console.log(`\n──── 4. BYPASS HIGH_CONVICTION events EU 24h ────\n`);
  const { data: bypassEvents } = await sb
    .from('trader_agent_decisions')
    .select('decided_at, target_symbol, action_kind, action_applied, thesis')
    .eq('portfolio_id', TRADER)
    .eq('action_kind', 'open_directional')
    .gte('decided_at', since24h);
  console.log(`Total bypass open_directional EU : ${bypassEvents?.length ?? 0}`);
  for (const e of bypassEvents ?? []) {
    const ok = e.action_applied ? '✅' : '❌';
    console.log(`  ${ok} ${e.decided_at?.slice(11,19)} ${e.target_symbol?.padEnd(14)} ${(e.thesis ?? '').slice(0, 60)}`);
  }

  // 5. SKIP EVENTS — gates qui bloquent encore sur EU (60min récent)
  console.log(`\n──── 5. SKIP EVENTS EU (60min) ────\n`);
  const { data: skips } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', sinceNow);
  const gateCounts = new Map<string, { count: number; symbols: Set<string>; isReal: boolean }>();
  for (const s of skips ?? []) {
    const p = s.payload as any;
    if (p?.asset_class !== 'eu_equity') continue;
    const gate = p?.gate ?? 'unknown';
    const reason = p?.reason ?? p?.verdict ?? '';
    const key = `${gate}${reason ? `_${reason}` : ''}`;
    const isReal = !(gate === 'CHOP_NOISE' && p?.verdict === 'blind_pass');
    const acc = gateCounts.get(key) ?? { count: 0, symbols: new Set<string>(), isReal };
    acc.count++;
    if (p?.symbol) acc.symbols.add(p.symbol);
    gateCounts.set(key, acc);
  }
  for (const [k, v] of [...gateCounts].sort((a,b) => b[1].count - a[1].count)) {
    const flag = v.isReal ? '🔴' : '⚪';
    console.log(`  ${flag} ${k.padEnd(35)} ${v.count}× (${[...v.symbols].slice(0,3).join(',')})`);
  }
  if (gateCounts.size === 0) console.log('  ✅ Aucun skip EU sur 60min');

  // 6. POSITION_OPEN_FAILED EU
  console.log(`\n──── 6. POSITION_OPEN_FAILED EU 24h ────\n`);
  const { data: fails } = await sb
    .from('lisa_decision_log')
    .select('timestamp, payload')
    .eq('portfolio_id', TRADER)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', since24h);
  const failTypes = new Map<string, number>();
  for (const f of fails ?? []) {
    const p = f.payload as any;
    if (p?.asset_class !== 'eu_equity') continue;
    const errorClass = p?.error_class ?? 'unknown';
    failTypes.set(errorClass, (failTypes.get(errorClass) ?? 0) + 1);
  }
  if (failTypes.size === 0) console.log('  ✅ Zéro position_open_failed EU sur 24h');
  for (const [e, n] of failTypes) console.log(`  🔴 ${e.padEnd(35)} : ${n}`);
}
main().catch(e => { console.error(e); process.exit(1); });
