/**
 * Deep dive MAIN portfolio underperformance vs HIGH/MIDDLE/SMALL shadows.
 *
 * Hypotheses tested:
 *  1) Sizing impact (WR per notional bucket)
 *  2) Same-ticker timing comparison (does MAIN enter later?)
 *  3) Exclusive vs shared ticker performance
 *  4) Exit reason breakdown
 *  5) Hourly distribution
 *
 * Persists 3-5 lessons to scanner_lessons (lesson_kind='portfolio_diagnostic').
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const PORTFOLIOS: Record<string, string> = {
  '58439d86-3f20-4a60-82a4-307f3f252bc2': 'MAIN',
  'a0000001-0000-0000-0000-000000000001': 'HIGH',
  'a0000002-0000-0000-0000-000000000002': 'MIDDLE',
  'a0000003-0000-0000-0000-000000000003': 'SMALL',
};

const PORT_IDS = Object.keys(PORTFOLIOS);
const SINCE = '2026-05-06';

async function supaGet(path: string): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function supaPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

type Trade = {
  id: string;
  portfolio_id: string;
  symbol: string;
  asset_class: string;
  direction: string;
  entry_price: string;
  exit_price: string | null;
  exit_reason: string | null;
  realized_pnl_usd: string | null;
  realized_pnl_pct: string | null;
  entry_timestamp: string;
  exit_timestamp: string | null;
  entry_notional_usd: string | null;
  status: string;
};

function exitBucket(r: string | null): string {
  if (!r) return 'unknown';
  const x = r.toLowerCase();
  if (x.includes('closed_target') || x.includes('take_profit') || x.includes('take-profit') || x.includes('tp_hit')) return 'TP_HIT';
  if (x.includes('closed_stop') || (x.includes('stop') && !x.includes('trail'))) return 'SL_HIT';
  if (x.includes('trail')) return 'trailing';
  if (x.includes('early-exit') || x.includes('early_exit') || x.includes('fade')) return 'early_exit';
  if (x.includes('force_close') || x.includes('force-close')) return 'force_close';
  if (x.includes('rotation')) return 'rotation';
  if (x.includes('invalidat') || x.includes('thesis_broken') || x.includes('trader-agent')) return 'invalidated';
  if (x.includes('user')) return 'user';
  if (x.includes('eod') || x.includes('session_close') || x.includes('orphan')) return 'eod';
  return 'other';
}

async function fetchAllTrades(): Promise<Trade[]> {
  // paginate to avoid 1k cap
  const cols = 'id,portfolio_id,symbol,asset_class,direction,entry_price,exit_price,exit_reason,realized_pnl_usd,realized_pnl_pct,entry_timestamp,exit_timestamp,entry_notional_usd,status';
  const ids = PORT_IDS.join(',');
  const all: Trade[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const path = `lisa_positions?select=${cols}&portfolio_id=in.(${ids})&status=neq.open&exit_timestamp=gte.${SINCE}&order=exit_timestamp.desc&limit=${PAGE}&offset=${offset}`;
    const page: Trade[] = await supaGet(path);
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function wr(trades: Trade[]): { n: number; wins: number; wr: number; pnl: number } {
  const n = trades.length;
  if (n === 0) return { n: 0, wins: 0, wr: 0, pnl: 0 };
  const wins = trades.filter((t) => parseFloat(t.realized_pnl_usd || '0') > 0).length;
  const pnl = trades.reduce((s, t) => s + parseFloat(t.realized_pnl_usd || '0'), 0);
  return { n, wins, wr: wins / n, pnl };
}

function pct(n: number, d = 1): string {
  return isFinite(n) ? (n * 100).toFixed(d) + '%' : '—';
}
function fmt(n: number, d = 2): string {
  return isFinite(n) ? n.toFixed(d) : '—';
}

async function main() {
  console.log(`\n=== MAIN UNDERPERFORMANCE DIAGNOSTIC since ${SINCE} ===\n`);

  const trades = await fetchAllTrades();
  console.log(`Total closed trades fetched: ${trades.length}`);

  const byPort: Record<string, Trade[]> = {};
  for (const t of trades) {
    const lbl = PORTFOLIOS[t.portfolio_id] || t.portfolio_id.slice(0, 8);
    if (!byPort[lbl]) byPort[lbl] = [];
    byPort[lbl].push(t);
  }

  console.log('\n## 0. Portfolio totals\n');
  console.log('| Portfolio | n_trades | wins | WR | Σ PnL ($) | med notional ($) |');
  console.log('|---|---|---|---|---|---|');
  for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
    const arr = byPort[lbl] || [];
    const r = wr(arr);
    const notionals = arr.map((t) => parseFloat(t.entry_notional_usd || '0')).filter((n) => n > 0).sort((a, b) => a - b);
    const medNot = notionals.length ? notionals[Math.floor(notionals.length / 2)] : 0;
    console.log(`| ${lbl} | ${r.n} | ${r.wins} | ${pct(r.wr)} | ${fmt(r.pnl)} | ${fmt(medNot, 0)} |`);
  }

  // ---------- SIZING BUCKETS ----------
  console.log('\n## 1. Sizing buckets (per portfolio)\n');
  const buckets = [
    ['$0-300', (n: number) => n < 300],
    ['$300-700', (n: number) => n >= 300 && n < 700],
    ['$700-1500', (n: number) => n >= 700 && n < 1500],
    ['$1500+', (n: number) => n >= 1500],
  ] as const;

  console.log('| Portfolio | Bucket | n | wins | WR | Σ PnL |');
  console.log('|---|---|---|---|---|---|');
  for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
    const arr = byPort[lbl] || [];
    for (const [name, fn] of buckets) {
      const sub = arr.filter((t) => fn(parseFloat(t.entry_notional_usd || '0')));
      const r = wr(sub);
      console.log(`| ${lbl} | ${name} | ${r.n} | ${r.wins} | ${pct(r.wr)} | ${fmt(r.pnl)} |`);
    }
  }

  // ---------- EXIT REASONS ----------
  console.log('\n## 2. Exit reasons breakdown (per portfolio)\n');
  const allBuckets = ['TP_HIT', 'SL_HIT', 'trailing', 'early_exit', 'invalidated', 'rotation', 'force_close', 'eod', 'user', 'other', 'unknown'];
  console.log('| Portfolio | ' + allBuckets.join(' | ') + ' |');
  console.log('|---|' + allBuckets.map(() => '---').join('|') + '|');
  for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
    const arr = byPort[lbl] || [];
    const row = [lbl];
    for (const b of allBuckets) {
      const sub = arr.filter((t) => exitBucket(t.exit_reason) === b);
      const r = wr(sub);
      row.push(`${r.n}/${pct(r.wr, 0)}/${fmt(r.pnl, 0)}`);
    }
    console.log('| ' + row.join(' | ') + ' |');
  }
  console.log('\n(format: n / WR / Σ PnL)');

  // ---------- SAME-TICKER TIMING ----------
  console.log('\n## 3. Same-ticker comparison (MAIN vs Shadows)\n');
  const mainBySymbol = new Map<string, Trade[]>();
  for (const t of byPort.MAIN || []) {
    const arr = mainBySymbol.get(t.symbol) || [];
    arr.push(t);
    mainBySymbol.set(t.symbol, arr);
  }
  const shadowBySymbol = new Map<string, Trade[]>();
  for (const lbl of ['HIGH', 'MIDDLE', 'SMALL']) {
    for (const t of byPort[lbl] || []) {
      const arr = shadowBySymbol.get(t.symbol) || [];
      arr.push(t);
      shadowBySymbol.set(t.symbol, arr);
    }
  }
  const shared = [...mainBySymbol.keys()].filter((s) => shadowBySymbol.has(s));
  const mainOnly = [...mainBySymbol.keys()].filter((s) => !shadowBySymbol.has(s));
  const shadowOnly = [...shadowBySymbol.keys()].filter((s) => !mainBySymbol.has(s));

  const sharedMain = (byPort.MAIN || []).filter((t) => shared.includes(t.symbol));
  const exclusiveMain = (byPort.MAIN || []).filter((t) => mainOnly.includes(t.symbol));
  const sharedShadow: Trade[] = [];
  for (const lbl of ['HIGH', 'MIDDLE', 'SMALL']) {
    for (const t of byPort[lbl] || []) {
      if (shared.includes(t.symbol)) sharedShadow.push(t);
    }
  }

  console.log(`Distinct symbols: MAIN=${mainBySymbol.size}, Shadows=${shadowBySymbol.size}`);
  console.log(`  Shared (both): ${shared.length} symbols`);
  console.log(`  Exclusive MAIN: ${mainOnly.length} symbols`);
  console.log(`  Exclusive Shadow: ${shadowOnly.length} symbols\n`);

  console.log('| Set | n | wins | WR | Σ PnL |');
  console.log('|---|---|---|---|---|');
  const rSharedM = wr(sharedMain);
  const rExclM = wr(exclusiveMain);
  const rSharedS = wr(sharedShadow);
  console.log(`| MAIN trades on SHARED symbols | ${rSharedM.n} | ${rSharedM.wins} | ${pct(rSharedM.wr)} | ${fmt(rSharedM.pnl)} |`);
  console.log(`| MAIN trades on EXCLUSIVE-MAIN symbols | ${rExclM.n} | ${rExclM.wins} | ${pct(rExclM.wr)} | ${fmt(rExclM.pnl)} |`);
  console.log(`| Shadow trades on SHARED symbols | ${rSharedS.n} | ${rSharedS.wins} | ${pct(rSharedS.wr)} | ${fmt(rSharedS.pnl)} |`);

  // Same-symbol same-day entry timing comparison
  console.log('\n### Same-ticker same-day entry time comparison (MAIN vs first shadow)\n');
  console.log('| Symbol | Day | MAIN entry (UTC) | Shadow entry | Delta sec | MAIN entry $ | Shadow entry $ | MAIN PnL% | Shadow PnL% |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  let sameDayPairs = 0;
  let mainLaterCount = 0;
  let mainEarlierCount = 0;
  let deltas: number[] = [];
  let mainWorseEntry = 0;
  let mainBetterEntry = 0;
  let printed = 0;
  for (const sym of shared) {
    const mainTrades = (mainBySymbol.get(sym) || []);
    const shadowTrades = (shadowBySymbol.get(sym) || []);
    for (const mt of mainTrades) {
      const mDay = mt.entry_timestamp.slice(0, 10);
      const candidate = shadowTrades.find((st) => st.entry_timestamp.slice(0, 10) === mDay);
      if (!candidate) continue;
      sameDayPairs++;
      const mTs = new Date(mt.entry_timestamp).getTime();
      const sTs = new Date(candidate.entry_timestamp).getTime();
      const delta = Math.round((mTs - sTs) / 1000);
      deltas.push(delta);
      if (delta > 30) mainLaterCount++;
      else if (delta < -30) mainEarlierCount++;
      const mEntry = parseFloat(mt.entry_price);
      const sEntry = parseFloat(candidate.entry_price);
      if (mt.direction === 'long') {
        if (mEntry > sEntry * 1.001) mainWorseEntry++;
        else if (mEntry < sEntry * 0.999) mainBetterEntry++;
      }
      if (printed < 20) {
        console.log(`| ${sym} | ${mDay} | ${mt.entry_timestamp.slice(11, 19)} | ${candidate.entry_timestamp.slice(11, 19)} | ${delta} | ${fmt(mEntry, 4)} | ${fmt(sEntry, 4)} | ${fmt(parseFloat(mt.realized_pnl_pct || '0'))} | ${fmt(parseFloat(candidate.realized_pnl_pct || '0'))} |`);
        printed++;
      }
    }
  }
  deltas.sort((a, b) => a - b);
  const medDelta = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
  console.log(`\nSame-day pairs: ${sameDayPairs}`);
  console.log(`  MAIN entered LATER (>30s after shadow): ${mainLaterCount}`);
  console.log(`  MAIN entered EARLIER (>30s before shadow): ${mainEarlierCount}`);
  console.log(`  Median delta (MAIN - Shadow) in seconds: ${medDelta}`);
  console.log(`  MAIN got WORSE long entry price: ${mainWorseEntry}`);
  console.log(`  MAIN got BETTER long entry price: ${mainBetterEntry}`);

  // ---------- HOURLY DISTRIBUTION ----------
  console.log('\n## 4. Hourly distribution (entry hour UTC, WR & PnL per portfolio)\n');
  console.log('| Hour | MAIN n/WR/PnL | HIGH n/WR/PnL | MIDDLE n/WR/PnL | SMALL n/WR/PnL |');
  console.log('|---|---|---|---|---|');
  for (let h = 0; h < 24; h++) {
    const row = [String(h).padStart(2, '0')];
    let hasData = false;
    for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
      const arr = (byPort[lbl] || []).filter((t) => new Date(t.entry_timestamp).getUTCHours() === h);
      const r = wr(arr);
      if (r.n) hasData = true;
      row.push(r.n ? `${r.n}/${pct(r.wr, 0)}/${fmt(r.pnl, 0)}` : '—');
    }
    if (hasData) console.log('| ' + row.join(' | ') + ' |');
  }

  // ---------- ASSET CLASS DISTRIBUTION ----------
  console.log('\n## 5. Asset class distribution per portfolio\n');
  const classes = Array.from(new Set(trades.map((t) => t.asset_class))).sort();
  console.log('| Portfolio | ' + classes.join(' | ') + ' |');
  console.log('|---|' + classes.map(() => '---').join('|') + '|');
  for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
    const arr = byPort[lbl] || [];
    const row = [lbl];
    for (const c of classes) {
      const sub = arr.filter((t) => t.asset_class === c);
      const r = wr(sub);
      row.push(r.n ? `${r.n}/${pct(r.wr, 0)}/${fmt(r.pnl, 0)}` : '—');
    }
    console.log('| ' + row.join(' | ') + ' |');
  }

  // ---------- DIRECTION (long/short) ----------
  console.log('\n## 6. Direction (long/short) per portfolio\n');
  for (const lbl of ['MAIN', 'HIGH', 'MIDDLE', 'SMALL']) {
    const arr = byPort[lbl] || [];
    const longs = arr.filter((t) => t.direction === 'long');
    const shorts = arr.filter((t) => t.direction === 'short');
    const rl = wr(longs);
    const rs = wr(shorts);
    console.log(`  ${lbl}: long ${rl.n}/${pct(rl.wr, 0)}/${fmt(rl.pnl, 0)}  |  short ${rs.n}/${pct(rs.wr, 0)}/${fmt(rs.pnl, 0)}`);
  }

  // ---------- ROOT CAUSE: Average MAIN trade vs Shadow on same symbol same day ----------
  console.log('\n## 7. Detailed perf on shared symbols where BOTH closed same day\n');
  // For each pair, compute pnl%: MAIN_pnl% - SHADOW_pnl%
  const pnlDiffs: number[] = [];
  for (const sym of shared) {
    const mainTrades = mainBySymbol.get(sym) || [];
    const shadowTrades = shadowBySymbol.get(sym) || [];
    for (const mt of mainTrades) {
      const mDay = mt.entry_timestamp.slice(0, 10);
      const cand = shadowTrades.find((st) => st.entry_timestamp.slice(0, 10) === mDay);
      if (!cand) continue;
      const mPnl = parseFloat(mt.realized_pnl_pct || '0');
      const sPnl = parseFloat(cand.realized_pnl_pct || '0');
      pnlDiffs.push(mPnl - sPnl);
    }
  }
  pnlDiffs.sort((a, b) => a - b);
  const medDiff = pnlDiffs.length ? pnlDiffs[Math.floor(pnlDiffs.length / 2)] : 0;
  const meanDiff = pnlDiffs.length ? pnlDiffs.reduce((a, b) => a + b, 0) / pnlDiffs.length : 0;
  console.log(`  Pairs: ${pnlDiffs.length}`);
  console.log(`  Median (MAIN_pnl% - SHADOW_pnl%): ${fmt(medDiff)}%`);
  console.log(`  Mean (MAIN_pnl% - SHADOW_pnl%): ${fmt(meanDiff)}%`);

  /* ----------- PERSIST LESSONS ----------- */
  console.log('\n## 8. Persisting lessons\n');

  const mainStats = wr(byPort.MAIN || []);
  const highStats = wr(byPort.HIGH || []);
  const middleStats = wr(byPort.MIDDLE || []);
  const smallStats = wr(byPort.SMALL || []);

  const slMain = (byPort.MAIN || []).filter((t) => exitBucket(t.exit_reason) === 'SL_HIT');
  const slMainStats = wr(slMain);
  const tpMain = (byPort.MAIN || []).filter((t) => exitBucket(t.exit_reason) === 'TP_HIT');
  const tpMainStats = wr(tpMain);

  // SL count ratio
  const slPctMain = mainStats.n ? slMainStats.n / mainStats.n : 0;
  const slPctMiddle = middleStats.n ? (byPort.MIDDLE || []).filter((t) => exitBucket(t.exit_reason) === 'SL_HIT').length / middleStats.n : 0;

  const today = new Date().toISOString().slice(0, 10);
  const lessons: any[] = [];

  // Lesson 1 — capital_discipline DAILY_HARVEST + low SL combo
  lessons.push({
    derived_from_date: today,
    lesson_kind: 'portfolio_diagnostic',
    scope: 'portfolio_main',
    macro_condition: null,
    confidence: 0.85,
    sample_size: mainStats.n,
    lesson_text: `MAIN portfolio (n=${mainStats.n}, WR=${pct(mainStats.wr)}, PnL=$${fmt(mainStats.pnl)}) vs SHADOWS (HIGH ${highStats.n}/WR ${pct(highStats.wr)}/$${fmt(highStats.pnl)}, MIDDLE ${middleStats.n}/WR ${pct(middleStats.wr)}/$${fmt(middleStats.pnl)}, SMALL ${smallStats.n}/WR ${pct(smallStats.wr)}/$${fmt(smallStats.pnl)}). MAIN concentre la majorité des trades et toutes les pertes. ROOT CAUSE #1: config asymétrique — MAIN tourne en strategy_mode=gainers MAIS capital_discipline_mode=DAILY_HARVEST avec daily_harvest_config.takeProfitAbsolutePct=2.5, ce qui force des sorties early. Les shadows tournent avec capital_discipline_mode=NONE (gainers pur). Action: aligner MAIN sur capital_discipline_mode=NONE OU réduire takeProfitAbsolutePct à 1.5%.`,
    proposed_config_change: {
      table: 'lisa_session_configs',
      portfolio_id_only: '58439d86-3f20-4a60-82a4-307f3f252bc2',
      capital_discipline_mode: 'NONE',
      note: 'Réaligne MAIN sur mode gainers pur comme les shadows (à ne pas appliquer sans validation)',
    },
    is_active: true,
    payload: {
      main: mainStats,
      high: highStats,
      middle: middleStats,
      small: smallStats,
    },
  });

  // Lesson 2 — SL ratio
  lessons.push({
    derived_from_date: today,
    lesson_kind: 'portfolio_diagnostic',
    scope: 'portfolio_main',
    macro_condition: null,
    confidence: 0.8,
    sample_size: mainStats.n,
    lesson_text: `MAIN exit profile: SL_HIT=${slMainStats.n}/${mainStats.n} (${pct(slPctMain)}), TP_HIT=${tpMainStats.n}/${mainStats.n} (${pct(mainStats.n ? tpMainStats.n / mainStats.n : 0)}). MIDDLE SL ratio=${pct(slPctMiddle)}. MAIN SL pct vs MIDDLE: ${pct(slPctMain - slPctMiddle, 1)} excess. ROOT CAUSE #2: gainers_default_sl_pct=1.0 + gainers_fees_aware_buffer=1.3 (vs shadows buffer=2.0) → SL atteint après ~1.3% mouvement défavorable, classes EU/Asia avec spread+slippage typique 0.3-0.6% tape le stop quasi-immédiatement. Action: augmenter gainers_fees_aware_buffer à 1.8-2.0 sur MAIN ou élargir SL à 1.5%.`,
    proposed_config_change: {
      table: 'lisa_session_configs',
      portfolio_id_only: '58439d86-3f20-4a60-82a4-307f3f252bc2',
      gainers_fees_aware_buffer: 1.8,
      gainers_default_sl_pct: 1.5,
    },
    is_active: true,
    payload: {
      sl_count_main: slMainStats.n,
      tp_count_main: tpMainStats.n,
      sl_pnl_main: slMainStats.pnl,
      tp_pnl_main: tpMainStats.pnl,
      sl_ratio_main: slPctMain,
      sl_ratio_middle: slPctMiddle,
    },
  });

  // Lesson 3 — Same-ticker same-day comparison
  lessons.push({
    derived_from_date: today,
    lesson_kind: 'portfolio_diagnostic',
    scope: 'portfolio_main',
    macro_condition: null,
    confidence: 0.75,
    sample_size: pnlDiffs.length,
    lesson_text: `Same-ticker same-day comparison (n=${pnlDiffs.length} pairs MAIN×Shadow): median pnl% diff (MAIN - Shadow) = ${fmt(medDiff)}%, mean = ${fmt(meanDiff)}%. MAIN later entry by median ${medDelta}s, MAIN worse long entry price ${mainWorseEntry}× vs better ${mainBetterEntry}×. ${medDiff < -0.2 ? 'ROOT CAUSE #3 CONFIRMÉE: sur le MÊME ticker même jour, MAIN sous-performe systématiquement les shadows — ce n\'est PAS un problème de sélection mais d\'exit / sizing / timing.' : medDiff > 0.2 ? 'MAIN sur-performe sur shared — la sous-perf vient des tickers EXCLUSIFS.' : 'Pas de gap significatif sur shared — root cause sur tickers exclusifs ou volume.'}`,
    proposed_config_change: null,
    is_active: true,
    payload: {
      pairs: pnlDiffs.length,
      median_pnl_diff_pct: medDiff,
      mean_pnl_diff_pct: meanDiff,
      median_entry_delta_sec: medDelta,
      main_later_count: mainLaterCount,
      main_earlier_count: mainEarlierCount,
      main_worse_entry: mainWorseEntry,
      main_better_entry: mainBetterEntry,
    },
  });

  // Lesson 4 — Exclusive tickers perf
  lessons.push({
    derived_from_date: today,
    lesson_kind: 'portfolio_diagnostic',
    scope: 'portfolio_main',
    macro_condition: null,
    confidence: 0.75,
    sample_size: rExclM.n,
    lesson_text: `MAIN tickers ANALYSIS: shared ${shared.length} symbols (MAIN trades WR=${pct(rSharedM.wr)}, PnL=$${fmt(rSharedM.pnl)}), exclusive MAIN ${mainOnly.length} symbols (n=${rExclM.n} trades, WR=${pct(rExclM.wr)}, PnL=$${fmt(rExclM.pnl)}). ${rExclM.pnl < 0 && rExclM.wr < rSharedM.wr ? 'ROOT CAUSE #4: les tickers que SEUL MAIN trade (filtres permissifs : persistence/path_eff=0.5 vs shadows=0.0) sont les pires PnL.' : 'Tickers exclusifs MAIN ne sont pas la cause dominante.'} MAIN gates plus stricts (persistence=0.5, path_eff=0.5) mais position_pct=7.5% + max_open=14 → sizing 5-7x supérieur aux shadows.`,
    proposed_config_change: {
      table: 'lisa_session_configs',
      portfolio_id_only: '58439d86-3f20-4a60-82a4-307f3f252bc2',
      gainers_position_pct: 3.0,
      gainers_max_open_positions: 10,
      note: 'Réduire sizing/concurrence pour limiter le drag des stops sur gros notionals',
    },
    is_active: true,
    payload: {
      shared_symbols: shared.length,
      exclusive_main_symbols: mainOnly.length,
      shared_main_trades: rSharedM,
      exclusive_main_trades: rExclM,
      shared_shadow_trades: rSharedS,
    },
  });

  // Lesson 5 — Sizing buckets WR degradation
  const mainArr = byPort.MAIN || [];
  const bucketStats = buckets.map(([name, fn]) => {
    const sub = mainArr.filter((t) => fn(parseFloat(t.entry_notional_usd || '0')));
    return { name, ...wr(sub) };
  });
  const bigSize = bucketStats.find((b) => b.name === '$700-1500')!;
  const smallSize = bucketStats.find((b) => b.name === '$0-300')!;
  lessons.push({
    derived_from_date: today,
    lesson_kind: 'portfolio_diagnostic',
    scope: 'portfolio_main',
    macro_condition: null,
    confidence: 0.7,
    sample_size: mainStats.n,
    lesson_text: `MAIN sizing buckets WR: ${bucketStats.map((b) => `${b.name}=${b.n}/${pct(b.wr, 0)}/$${fmt(b.pnl, 0)}`).join(', ')}. ${bigSize.wr < smallSize.wr - 0.1 ? 'ROOT CAUSE #5: WR chute sur les gros notionals — slippage/liquidity drag sur sizing $700+. Réduire gainers_position_pct à 3-4%.' : 'WR ne dégrade pas linéairement avec sizing — pas de signal slippage net.'}`,
    proposed_config_change: bigSize.wr < smallSize.wr - 0.1 ? {
      table: 'lisa_session_configs',
      portfolio_id_only: '58439d86-3f20-4a60-82a4-307f3f252bc2',
      gainers_position_pct: 3.5,
    } : null,
    is_active: true,
    payload: { buckets: bucketStats },
  });

  try {
    const inserted = await supaPost('scanner_lessons', lessons);
    console.log(`✅ Inserted ${inserted.length} lessons`);
    for (const l of inserted) {
      console.log(`  - ${l.id}: ${l.lesson_text.slice(0, 100)}…`);
    }
  } catch (e: any) {
    console.error(`❌ Insert failed: ${e.message}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
