/**
 * Audit complet mode GAINERS — 3 portfolios (TRADER autopilot + MIDDLE/SMALL shadow).
 *
 * Couvre :
 *   1. Config session des 3 portfolios gainers
 *   2. Positions ouvertes par portfolio + source
 *   3. PnL réalisé scopé UTC day (hier + aujourd'hui)
 *   4. Decision_log activité 24h
 *   5. Cron scanner top-gainers + opportunity_scout + risk-monitor
 *   6. Anomalies récentes
 *   7. Capital exposé + estimation fees IBKR
 *
 *   npx tsx scripts/audit-gainers.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PORTFOLIOS = {
  TRADER: 'b0000001-0000-0000-0000-000000000001',
  MIDDLE: 'a0000002-0000-0000-0000-000000000002',
  SMALL: 'a0000003-0000-0000-0000-000000000003',
};
const NAMES = Object.fromEntries(Object.entries(PORTFOLIOS).map(([k, v]) => [v, k]));

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmt(n: number | string | null | undefined, d = 2): string {
  if (n == null) return 'n/a';
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(d) : 'n/a';
}
function fmtUsd(n: number | string | null | undefined): string {
  if (n == null) return 'n/a';
  const v = Number(n);
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
}
function fmtT(v: unknown) { return String(v ?? '').replace('T', ' ').slice(0, 16); }

async function main() {
  const now = new Date();
  const todayUTC = now.toISOString().slice(0, 10);
  const yUTC = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const todayStart = `${todayUTC}T00:00:00Z`;
  const yStart = `${yUTC}T00:00:00Z`;
  const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(` AUDIT COMPLET — GAINERS MODE  @  ${now.toISOString().slice(0,19)}Z`);
  console.log(`   Aujourd'hui UTC : ${todayUTC}  |  Hier UTC : ${yUTC}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  // ─── 1. Config session ──────────────────────────────────────────────────
  const { data: cfgs } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, autopilot_enabled, kill_switch_active, autopilot_paused_reason, capital_usd, profile, daily_cost_budget_usd')
    .in('portfolio_id', Object.values(PORTFOLIOS));

  console.log('\n[1] SESSION CONFIG');
  for (const c of cfgs ?? []) {
    const name = NAMES[c.portfolio_id as string];
    console.log(`  ${pad(name, 8)} mode=${c.strategy_mode} ap=${c.autopilot_enabled} ks=${c.kill_switch_active} cap=$${c.capital_usd} profile=${c.profile} budget=$${c.daily_cost_budget_usd ?? 'none'}`);
  }

  // ─── 2. Positions ouvertes ───────────────────────────────────────────────
  console.log('\n[2] POSITIONS OUVERTES par portfolio + source');
  for (const [name, pid] of Object.entries(PORTFOLIOS)) {
    const { data: open, count } = await sb
      .from('lisa_positions')
      .select('symbol, entry_timestamp, entry_price, take_profit_price, stop_loss_price, entry_notional_usd, venue_fee_detail, asset_class', { count: 'exact' })
      .eq('portfolio_id', pid)
      .eq('status', 'open');
    const bySource = new Map<string, number>();
    let totalNotional = 0;
    for (const p of open ?? []) {
      const src = String((p.venue_fee_detail as Record<string, unknown> | null)?.source ?? '(null)');
      bySource.set(src, (bySource.get(src) ?? 0) + 1);
      totalNotional += Number(p.entry_notional_usd ?? 0);
    }
    console.log(`\n  ${name} : ${count ?? 0} positions ouvertes, Σ notional $${totalNotional.toFixed(0)}`);
    for (const [s, n] of bySource) console.log(`    ${s.padEnd(25)} → ${n}`);
    if (open?.length) {
      console.log(`    Échantillon :`);
      for (const p of open.slice(0, 5)) {
        const age = Math.round((Date.now() - new Date(String(p.entry_timestamp)).getTime()) / 60_000);
        console.log(`      ${String(p.symbol).padEnd(12)} @ ${fmt(p.entry_price)} TP=${fmt(p.take_profit_price)} SL=${fmt(p.stop_loss_price)} notional=$${fmt(p.entry_notional_usd, 0)} age=${age}min`);
      }
    }
  }

  // ─── 3. PnL par UTC day ──────────────────────────────────────────────────
  console.log('\n[3] PnL RÉALISÉ par portfolio (gainers sources)');
  for (const [name, pid] of Object.entries(PORTFOLIOS)) {
    for (const dayLabel of ['HIER', 'AUJOURD\'HUI']) {
      const from = dayLabel === 'HIER' ? yStart : todayStart;
      const to = dayLabel === 'HIER' ? todayStart : new Date(new Date(todayStart).getTime() + 86400_000).toISOString();
      const { data: closed } = await sb
        .from('lisa_positions')
        .select('symbol, exit_timestamp, exit_reason, realized_pnl_usd, realized_pnl_pct, status, venue_fee_detail')
        .eq('portfolio_id', pid)
        .like('status', 'closed%')
        .gte('exit_timestamp', from)
        .lt('exit_timestamp', to);
      const gainers = (closed ?? []).filter(p => {
        const src = String((p.venue_fee_detail as Record<string, unknown> | null)?.source ?? '');
        return src.includes('gainers') || src === 'opportunity_scout' || src.includes('top_gainers');
      });
      let sumPnl = 0, w = 0, l = 0;
      const byReason = new Map<string, { n: number; pnl: number }>();
      for (const p of gainers) {
        const pnl = Number(p.realized_pnl_usd ?? 0);
        sumPnl += pnl;
        if (pnl > 0) w++; else if (pnl < 0) l++;
        const r = String(p.exit_reason ?? p.status);
        const acc = byReason.get(r) ?? { n: 0, pnl: 0 };
        acc.n++; acc.pnl += pnl;
        byReason.set(r, acc);
      }
      const wr = w + l > 0 ? ((w / (w + l)) * 100).toFixed(0) + '%' : '–';
      console.log(`  ${pad(name, 8)} ${pad(dayLabel, 12)} : ${gainers.length} closes  Σ $${fmtUsd(sumPnl)}  WR ${wr} (${w}W/${l}L)`);
      if (byReason.size > 0) {
        for (const [r, { n, pnl }] of [...byReason].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))) {
          console.log(`    ${pad(r, 30)} → n=${pad(n, 3)} Σ=$${fmtUsd(pnl)}`);
        }
      }
    }
  }

  // ─── 4. Activité decision_log 6h ─────────────────────────────────────────
  console.log('\n[4] decision_log activité 6h (TOUS portfolios gainers confondus)');
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('kind, portfolio_id')
    .in('portfolio_id', Object.values(PORTFOLIOS))
    .gte('timestamp', since6h)
    .limit(2000);
  const byKindByPf = new Map<string, Map<string, number>>();
  for (const e of events ?? []) {
    const name = NAMES[e.portfolio_id as string];
    const m = byKindByPf.get(e.kind as string) ?? new Map<string, number>();
    m.set(name, (m.get(name) ?? 0) + 1);
    byKindByPf.set(e.kind as string, m);
  }
  const sorted = [...byKindByPf.entries()].sort((a, b) => {
    const totalA = [...a[1].values()].reduce((s, n) => s + n, 0);
    const totalB = [...b[1].values()].reduce((s, n) => s + n, 0);
    return totalB - totalA;
  });
  for (const [kind, pfMap] of sorted.slice(0, 20)) {
    const total = [...pfMap.values()].reduce((s, n) => s + n, 0);
    const breakdown = [...pfMap.entries()].map(([p, n]) => `${p}=${n}`).join(' ');
    console.log(`  ${pad(kind, 45)} → total ${pad(total, 4)}  (${breakdown})`);
  }

  // ─── 5. Risk-monitor activity ───────────────────────────────────────────
  console.log('\n[5] RISK-MONITOR (Gemini) — derniers verdicts par portfolio 24h');
  for (const [name, pid] of Object.entries(PORTFOLIOS)) {
    const { count } = await sb
      .from('lisa_decision_log')
      .select('id', { count: 'exact', head: true })
      .eq('portfolio_id', pid)
      .eq('kind', 'risk_advisory')
      .gte('timestamp', since24h);
    console.log(`  ${pad(name, 8)} : ${count ?? 0} advisories risk-monitor 24h`);
  }

  // ─── 6. Capital exposé peak hier/aujourd'hui ────────────────────────────
  console.log('\n[6] CAPITAL EXPOSÉ peak (hier UTC + aujourd\'hui)');
  for (const [name, pid] of Object.entries(PORTFOLIOS)) {
    const { data: posY } = await sb
      .from('lisa_positions')
      .select('entry_timestamp, exit_timestamp, entry_notional_usd, venue_fee_detail')
      .eq('portfolio_id', pid)
      .gte('entry_timestamp', yStart)
      .lt('entry_timestamp', new Date(new Date(todayStart).getTime() + 86400_000).toISOString());
    if (!posY?.length) { console.log(`  ${pad(name, 8)} : aucune position 2j`); continue; }
    type Event = { ts: string; delta: number };
    const events: Event[] = [];
    for (const p of posY) {
      const src = String((p.venue_fee_detail as Record<string, unknown> | null)?.source ?? '');
      if (!src.includes('gainers') && src !== 'opportunity_scout' && !src.includes('top_gainers')) continue;
      const notional = Number(p.entry_notional_usd ?? 0);
      events.push({ ts: p.entry_timestamp as string, delta: +notional });
      if (p.exit_timestamp) events.push({ ts: p.exit_timestamp as string, delta: -notional });
    }
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    let cur = 0, peak = 0, peakTs = '';
    for (const e of events) {
      cur += e.delta;
      if (cur > peak) { peak = cur; peakTs = e.ts; }
    }
    const cfg = (cfgs ?? []).find(c => c.portfolio_id === pid);
    const ratio = cfg?.capital_usd ? `${((peak / Number(cfg.capital_usd)) * 100).toFixed(0)}% capital` : '';
    console.log(`  ${pad(name, 8)} peak exposure $${peak.toFixed(0)} @ ${fmtT(peakTs)} UTC  ${ratio}`);
  }

  // ─── 7. Anomalies récentes ──────────────────────────────────────────────
  console.log('\n[7] ANOMALIES 24h');
  const { data: errors } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, portfolio_id, summary')
    .in('portfolio_id', Object.values(PORTFOLIOS))
    .in('kind', ['position_open_failed', 'risk_manager_thesis_broken', 'autopilot_paused', 'kill_switch_triggered'])
    .gte('timestamp', since24h)
    .order('timestamp', { ascending: false })
    .limit(15);
  if (!errors?.length) console.log('  Aucune anomalie sur 24h ✅');
  for (const e of errors ?? []) {
    console.log(`  ${fmtT(e.timestamp)} ${pad(NAMES[e.portfolio_id as string], 8)} ${pad(e.kind, 32)} ${String(e.summary ?? '').slice(0, 60)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
