/**
 * Checkpoint complet — état actuel du système après 2 jours de dev intensif.
 *
 * Sections :
 *  1. POSITIONS — opens, closes, PnL, sizing distribution
 *  2. GEMINI RISK MANAGER V2 — activations, verdicts, news fetched
 *  3. NEWS COVERAGE — par source, par classe, gap Asia/EU
 *  4. AUTRES AGENTS — RiskMonitor, OpportunityScout, DebateGate, Narrative
 *  5. DEV WORK 24→26/05 — commits, calibrations, fix incidents
 */
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);
const PID = 'b0000001-0000-0000-0000-000000000001';
const TODAY_START = '2026-05-26T00:00:00Z';
const YESTERDAY_START = '2026-05-25T00:00:00Z';

const sep = (s: string) => console.log(`\n${'═'.repeat(70)}\n  ${s}\n${'═'.repeat(70)}`);
const sub = (s: string) => console.log(`\n── ${s} ──`);

async function section1_positions() {
  sep('1. POSITIONS — opens, closes, PnL');

  // Open
  const { data: open } = await sb
    .from('lisa_positions')
    .select('symbol, direction, asset_class, entry_timestamp, entry_price, entry_notional_usd, stop_loss_price, take_profit_price')
    .eq('portfolio_id', PID).eq('status', 'open')
    .order('entry_timestamp', { ascending: false });

  sub(`OPEN POSITIONS (${open?.length ?? 0})`);
  const totalOpenNotional = (open ?? []).reduce((s, p) => s + Number(p.entry_notional_usd ?? 0), 0);
  console.log(`  Total exposure : $${totalOpenNotional.toFixed(2)}`);
  console.log(``);
  console.log(`  ${'Time'.padEnd(9)} ${'Symbol'.padEnd(15)} ${'Dir'.padEnd(6)} ${'Class'.padEnd(15)} ${'Entry'.padStart(10)} ${'Notion'.padStart(8)} ${'SL'.padStart(10)} ${'TP'.padStart(10)}`);
  for (const p of open ?? []) {
    console.log(`  ${p.entry_timestamp.slice(11, 16).padEnd(9)} ${p.symbol.padEnd(15)} ${p.direction.padEnd(6)} ${p.asset_class.padEnd(15)} ${String(p.entry_price).padStart(10)} $${String(p.entry_notional_usd).padStart(7)} ${String(p.stop_loss_price ?? '-').padStart(10)} ${String(p.take_profit_price ?? '-').padStart(10)}`);
  }

  // Closed today
  const { data: closed } = await sb
    .from('lisa_positions')
    .select('symbol, direction, asset_class, status, realized_pnl_usd, realized_pnl_pct, exit_reason, closed_at')
    .eq('portfolio_id', PID).gte('closed_at', TODAY_START).neq('status', 'open')
    .order('closed_at', { ascending: false });

  sub(`CLOSED TODAY (${closed?.length ?? 0})`);
  if (closed && closed.length > 0) {
    const totalPnl = closed.reduce((s, c) => s + Number(c.realized_pnl_usd ?? 0), 0);
    const wins = closed.filter((c) => Number(c.realized_pnl_usd ?? 0) > 0).length;
    const losses = closed.filter((c) => Number(c.realized_pnl_usd ?? 0) < 0).length;
    console.log(`  Realized PnL : $${totalPnl.toFixed(2)}`);
    console.log(`  Win rate     : ${wins}/${closed.length} = ${(wins / closed.length * 100).toFixed(0)}%`);
    console.log(``);
    for (const c of closed.slice(0, 12)) {
      const pnl = Number(c.realized_pnl_usd ?? 0);
      const sign = pnl >= 0 ? '+' : '';
      console.log(`  ${c.closed_at.slice(11, 16)} ${c.symbol.padEnd(15)} ${c.direction.padEnd(6)} ${c.status.padEnd(20)} ${sign}$${pnl.toFixed(2).padStart(7)} reason=${c.exit_reason ?? '-'}`);
    }
  } else {
    console.log('  (aucune position fermée aujourd\'hui)');
  }

  // Notional distribution
  if (open && open.length > 0) {
    sub(`SIZING DISTRIBUTION (opens)`);
    const buckets: Record<string, number> = {};
    for (const p of open) {
      const n = Math.round(Number(p.entry_notional_usd ?? 0));
      const bucket = n < 300 ? '<$300' : n < 500 ? '$300-500' : n < 800 ? '$500-800' : '>$800';
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const [b, n] of Object.entries(buckets)) console.log(`  ${b.padEnd(12)} ${n} positions`);
  }
}

async function section2_gemini() {
  sep('2. GEMINI RISK MANAGER V2');

  // Risk-related events depuis hier
  const { data: events } = await sb
    .from('lisa_decision_log')
    .select('timestamp, kind, summary, payload')
    .eq('portfolio_id', PID)
    .gte('timestamp', YESTERDAY_START)
    .or('kind.ilike.%risk%,kind.ilike.%thesis%,kind.ilike.%opportunity%,kind.ilike.%news_shock%,kind.ilike.%narrative%')
    .order('timestamp', { ascending: false });

  const byKind: Record<string, number> = {};
  for (const e of events ?? []) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  sub(`AGENT EVENTS 48h (par kind)`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${n}`);
  }

  // THESIS_BROKEN events (Gemini RM V2 actions)
  const thesisBroken = (events ?? []).filter((e) => e.kind === 'risk_manager_thesis_broken');
  sub(`THESIS_BROKEN events (Gemini RM auto-close 48h)`);
  if (thesisBroken.length === 0) {
    console.log('  (aucun — tous verdicts valid/unclear depuis 48h)');
  } else {
    for (const e of thesisBroken.slice(0, 10)) {
      const p = (e.payload ?? {}) as { symbol?: string; confidence?: number; reason?: string; mode?: string; auto_closed?: boolean };
      console.log(`  ${e.timestamp.slice(11, 19)} ${(p.symbol ?? '-').padEnd(15)} conf=${p.confidence?.toFixed(2) ?? '?'} mode=${p.mode ?? '?'} closed=${p.auto_closed} | ${(p.reason ?? '').slice(0, 60)}`);
    }
  }

  // RiskMonitor (per-class) actions
  const riskMonitor = (events ?? []).filter((e) => e.kind === 'risk_monitor_action');
  sub(`RISK_MONITOR_ACTION events (per-class composite 48h)`);
  if (riskMonitor.length === 0) {
    console.log('  (aucun — composites santé OK)');
  } else {
    for (const e of riskMonitor.slice(0, 10)) {
      console.log(`  ${e.timestamp.slice(11, 19)} ${(e.summary ?? '').slice(0, 100)}`);
    }
  }
}

async function section3_news() {
  sep('3. NEWS COVERAGE');

  // Total persistées + distribution suffix
  const { count: totalNews } = await sb
    .from('eodhd_news_articles')
    .select('*', { count: 'exact', head: true });
  console.log(`  Total news persistées : ${totalNews}`);

  const { data: sample } = await sb
    .from('eodhd_news_articles')
    .select('ticker, published_at')
    .order('published_at', { ascending: false })
    .limit(2000);
  const bySuffix: Record<string, number> = {};
  for (const r of sample ?? []) {
    const suffix = r.ticker?.split('.').pop() ?? 'NO_SUFFIX';
    bySuffix[suffix] = (bySuffix[suffix] ?? 0) + 1;
  }

  sub(`Coverage par suffix (top 10)`);
  for (const [s, n] of Object.entries(bySuffix).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${s.padEnd(12)} ${n}`);
  }

  // News 24h
  const { count: news24h } = await sb
    .from('eodhd_news_articles')
    .select('*', { count: 'exact', head: true })
    .gte('published_at', YESTERDAY_START);
  console.log(`\n  News 24h : ${news24h}`);

  // Gap Asia
  const asiaSuffixes = ['KO', 'KQ', 'SHE', 'SHG', 'T', 'HK', 'TSE'];
  const asiaCount = asiaSuffixes.reduce((s, suf) => s + (bySuffix[suf] ?? 0), 0);
  const euSuffixes = ['PA', 'L', 'LSE', 'DE', 'XETRA', 'SW', 'MI', 'AS'];
  const euCount = euSuffixes.reduce((s, suf) => s + (bySuffix[suf] ?? 0), 0);
  console.log(`\n  ⚠️  Gap structurel :`);
  console.log(`    Asia (${asiaSuffixes.join(',')}) : ${asiaCount} news → ${asiaCount === 0 ? '0 coverage' : 'partial'}`);
  console.log(`    EU   (${euSuffixes.join(',')}) : ${euCount} news → ${euCount === 0 ? '0 coverage' : 'partial'}`);
  console.log(`    US                          : ${bySuffix['US'] ?? 0} news (OK)`);
  console.log(`    → Compensé par Gemini Grounding si GEMINI_RISK_MANAGER_USE_GROUNDING=true`);

  // Economic events
  const { count: econ } = await sb
    .from('eodhd_economic_events')
    .select('*', { count: 'exact', head: true });
  console.log(`\n  Economic events (macro calendar) : ${econ}`);

  const { data: nextEvents } = await sb
    .from('eodhd_economic_events')
    .select('event_date, country, event_name, importance, actual, estimate')
    .gte('event_date', new Date().toISOString())
    .order('event_date', { ascending: true })
    .limit(5);
  sub(`Prochains events macro (5)`);
  for (const e of nextEvents ?? []) {
    console.log(`  ${e.event_date?.slice(0, 16)} ${e.country?.padEnd(4)} [${e.importance?.padEnd(6)}] ${e.event_name}`);
  }
}

async function section4_autres_agents() {
  sep('4. AUTRES AGENTS — état des autres pipelines');

  // DebateGate
  sub(`DebateGate (ring buffer in-mem, ne survit pas au boot)`);
  console.log(`  cf endpoint admin: /admin/debate-gate/metrics?hours=12`);

  // Shadow signals last 24h (scanner activity)
  const { count: shadows24h } = await sb
    .from('gainers_user_shadow_signals')
    .select('*', { count: 'exact', head: true })
    .eq('portfolio_id', PID)
    .gte('created_at', YESTERDAY_START);
  const { data: shadowsByDec } = await sb
    .from('gainers_user_shadow_signals')
    .select('decision')
    .eq('portfolio_id', PID)
    .gte('created_at', YESTERDAY_START);
  const decisionDist: Record<string, number> = {};
  for (const s of shadowsByDec ?? []) decisionDist[s.decision] = (decisionDist[s.decision] ?? 0) + 1;

  sub(`SCANNER GAINERS shadow signals 24h (${shadows24h})`);
  for (const [d, n] of Object.entries(decisionDist).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${d.padEnd(30)} ${n}`);
  }

  // Top gainers log (screener stage)
  const { count: tgl24h } = await sb
    .from('top_gainers_log')
    .select('*', { count: 'exact', head: true })
    .gte('captured_at', YESTERDAY_START);
  console.log(`\n  top_gainers_log 24h : ${tgl24h} captures`);

  // Position open failed events (skips)
  const { data: failures } = await sb
    .from('lisa_decision_log')
    .select('payload')
    .eq('portfolio_id', PID)
    .eq('kind', 'position_open_failed')
    .gte('timestamp', YESTERDAY_START);
  const failByClass: Record<string, number> = {};
  for (const f of failures ?? []) {
    const cls = (f.payload as { error_class?: string })?.error_class ?? 'unknown';
    failByClass[cls] = (failByClass[cls] ?? 0) + 1;
  }
  sub(`position_open_failed 48h (par error_class)`);
  for (const [k, n] of Object.entries(failByClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(40)} ${n}`);
  }
}

async function section5_dev() {
  sep('5. DEV WORK 24→26/05 — récap');
  console.log(`\nVoir git log pour détail. Highlights :\n`);
  console.log(`  J-2 (24/05) : Risk Manager V2 (Gemini news LLM) + Opportunity Scout + EU fixes`);
  console.log(`                staleness P19 (NANO.PA incident) — #458 mergé`);
  console.log(`\n  J-1 (25/05) : Calibration gates — persistence unset + path_eff US 0.40→0.30`);
  console.log(`                Backtest funnel Thu+Fri (786 candidats, 5% TP hit)`);
  console.log(`                Inventaire Fly secrets dans CLAUDE.md — #459 mergé`);
  console.log(`\n  Today (26/05) : Crisis morning — 67 ACCEPT shadow Asia / 0 open`);
  console.log(`                  Root cause cascade :`);
  console.log(`                    1. tagStaleness seuil 180s trop strict Asia → bump 3600s`);
  console.log(`                    2. Scanner-side stale guard → bypass Asia`);
  console.log(`                    3. Paper-broker stale guard (oublié) → bypass Asia`);
  console.log(`                    4. Conviction sizing skip silent → log decision_log + user secret OFF`);
  console.log(`                  Résultat : 14 positions Asia opens (vs 0 ce matin)`);
  console.log(`\n  Now : Gemini Search Grounding pour news Asia/EU (bypass EODHD limit)`);
  console.log(`        Flag : GEMINI_RISK_MANAGER_USE_GROUNDING=true (set par user)`);
  console.log(`        Cost estimé : free tier 500/jour Google Cloud, puis $35/1000`);
}

async function main() {
  console.log(`\n${'█'.repeat(70)}`);
  console.log(`  CHECKPOINT COMPLET — ${new Date().toISOString().slice(0, 19)} UTC`);
  console.log(`  Portfolio : ${PID.slice(0, 8)}`);
  console.log('█'.repeat(70));

  await section1_positions();
  await section2_gemini();
  await section3_news();
  await section4_autres_agents();
  await section5_dev();

  console.log(`\n${'█'.repeat(70)}\n  END\n${'█'.repeat(70)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
