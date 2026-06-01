import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
const env = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const TRADER = 'b0000001-0000-0000-0000-000000000001';
const SHADOWS = ['a0000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', 'a0000003-0000-0000-0000-000000000003'];
const SHADOW_NAMES: Record<string, string> = {
  [SHADOWS[0]]: 'HIGH', [SHADOWS[1]]: 'MIDDLE', [SHADOWS[2]]: 'SMALL',
};

async function main() {
  const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
  const since1h = new Date(Date.now() - 3600_000).toISOString();
  const since6h = new Date(Date.now() - 6*3600_000).toISOString();

  // ─── 1. TRADER actions today ───
  console.log('\n\x1b[1m═══ 1. TRADER DECISIONS — aujourd\'hui ═══\x1b[0m');
  const { data: dec } = await sb.from('trader_agent_decisions')
    .select('action_kind, action_applied, decided_at, gemini_parsed, applied_position_id, apply_error, input_state, thesis')
    .eq('portfolio_id', TRADER)
    .gte('decided_at', todayStart.toISOString())
    .order('decided_at', { ascending: false });
  const rows = (dec ?? []) as Array<any>;
  // Filtre sentinels (CYCLE_TICK, BOOT_SENTINEL) qui polluent le count avec
  // des décisions techniques "hold" non-LLM. On garde seulement les vraies
  // décisions LLM (thesis non-sentinel).
  const realDec = rows.filter(r => {
    const t = String(r.thesis ?? '');
    return !t.includes('CYCLE_TICK') && !t.includes('BOOT_SENTINEL') && !t.includes('REGISTRATION_SENTINEL');
  });
  const byKind: Record<string, number> = {};
  for (const r of realDec) byKind[r.action_kind] = (byKind[r.action_kind] ?? 0) + 1;
  const applied = realDec.filter(r => r.action_applied).length;
  const opens = realDec.filter(r => r.action_kind === 'open_directional' && r.action_applied).length;
  console.log(`  Total LLM decisions (hors sentinels): ${realDec.length} (raw rows: ${rows.length}) | Applied: ${applied} | Opens reels: ${opens}`);
  console.log(`  Breakdown: ${Object.entries(byKind).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k,v]) => `${k}=${v}`).join(', ')}`);

  // ─── 2. État LLM provider sur dernier cycle ───
  console.log('\n\x1b[1m═══ 2. MISTRAL vs GEMINI — provider du dernier cycle LLM ═══\x1b[0m');
  const latest = realDec[0] ?? rows[0];
  if (latest) {
    const gp = latest.gemini_parsed as any;
    const provId = gp?.providerId ?? gp?.provider_id ?? 'unknown';
    console.log(`  Dernier cycle ${latest.decided_at.slice(11,19)} UTC`);
    console.log(`  Provider final: ${provId}`);
    console.log(`  Action: ${latest.action_kind} (applied=${latest.action_applied})`);
    const cost = gp?.costUsd ?? gp?.cost_usd;
    if (cost != null) console.log(`  Cost: $${Number(cost).toFixed(5)}`);
    if (latest.thesis) {
      console.log(`\n  💭 Thesis last cycle (raisonnement Mistral) :`);
      console.log(`    "${String(latest.thesis).slice(0, 400)}…"`);
    }
  }
  // Stats AB shadow comparator: combien de fois Mistral primary vs Gemini fallback
  const { data: ab } = await sb.from('llm_ab_shadow_decisions')
    .select('call_site, applied_provider_id, mistral_call_error, mistral_large_call_error, created_at')
    .eq('call_site', 'trader_decision')
    .gte('created_at', since6h)
    .limit(100);
  const abRows = (ab ?? []) as Array<any>;
  const byProv: Record<string, number> = {};
  for (const r of abRows) byProv[r.applied_provider_id ?? 'unknown'] = (byProv[r.applied_provider_id ?? 'unknown'] ?? 0) + 1;
  const mistralErrors = abRows.filter(r => r.mistral_call_error).length;
  console.log(`\n  A/B shadow trader_decision sur 6h: ${abRows.length} cycles`);
  console.log(`  Provider primary appliqué : ${Object.entries(byProv).map(([k,v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  Mistral call errors: ${mistralErrors}/${abRows.length} (${abRows.length > 0 ? Math.round(100*mistralErrors/abRows.length) : 0}%)`);

  // ─── 3. Shadow Sizing HIGH/MIDDLE/SMALL ───
  console.log('\n\x1b[1m═══ 3. SHADOW SIZING — aujourd\'hui (live recompute depuis lisa_positions) ═══\x1b[0m');
  for (const pid of SHADOWS) {
    const { data: closed } = await sb.from('lisa_positions')
      .select('realized_pnl_usd, symbol, exit_reason, exit_timestamp')
      .eq('portfolio_id', pid)
      .neq('status', 'open')
      .gte('exit_timestamp', todayStart.toISOString());
    const { data: open } = await sb.from('lisa_positions')
      .select('symbol, entry_notional_usd, entry_timestamp, unrealized_pnl_usd')
      .eq('portfolio_id', pid)
      .eq('status', 'open');
    const c = (closed ?? []) as Array<any>;
    const o = (open ?? []) as Array<any>;
    const sumPnl = c.reduce((a, r) => a + Number(r.realized_pnl_usd ?? 0), 0);
    const wins = c.filter(r => Number(r.realized_pnl_usd ?? 0) > 0).length;
    const wr = c.length > 0 ? Math.round(100*wins/c.length) : 0;
    const sumNotional = o.reduce((a, r) => a + Number(r.entry_notional_usd ?? 0), 0);
    const sumUnreal = o.reduce((a, r) => a + Number(r.unrealized_pnl_usd ?? 0), 0);
    console.log(`\n  \x1b[1m${SHADOW_NAMES[pid]}\x1b[0m (${pid.slice(0,8)}):`);
    console.log(`    Aujourd'hui : ${c.length} closed (W${wins}/L${c.length-wins} = ${wr}% WR) | Σ realized = $${sumPnl.toFixed(2)}`);
    console.log(`    Ouvertes : ${o.length} pos · $${sumNotional.toFixed(0)} deployed · $${sumUnreal.toFixed(2)} unreal`);
    if (o.length > 0) console.log(`    Symbols open: ${o.map(p => p.symbol).join(', ')}`);
  }

  // ─── 4. News pipeline ───
  console.log('\n\x1b[1m═══ 4. NEWS PIPELINE — aujourd\'hui ═══\x1b[0m');
  const { count: newsCount } = await sb.from('eodhd_news_articles')
    .select('*', { count: 'exact', head: true })
    .gte('published_at', todayStart.toISOString());
  console.log(`  Total news EODHD ingérées today: ${newsCount ?? '?'}`);
  // Daily catalyst brief = stocké dans lisa_decision_log kind='daily_catalyst_brief'
  const { data: brief } = await sb.from('lisa_decision_log')
    .select('payload, timestamp, summary')
    .eq('kind', 'daily_catalyst_brief')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (brief && brief[0]) {
    const b = brief[0] as any;
    const p = b.payload ?? {};
    console.log(`\n  Daily Catalyst Brief (last):`);
    console.log(`    Generated: ${String(b.timestamp).slice(0,16)} UTC`);
    if (Array.isArray(p.tickers_in_focus)) console.log(`    Tickers in focus: ${p.tickers_in_focus.slice(0, 8).join(', ')}`);
    if (Array.isArray(p.tickers_to_avoid)) console.log(`    Tickers to avoid: ${p.tickers_to_avoid.slice(0, 8).join(', ')}`);
    if (Array.isArray(p.top_events)) console.log(`    Top events: ${p.top_events.length} mentioned (sample: ${p.top_events.slice(0,2).map((e: any) => e.title ?? e.event ?? '?').join(' | ')})`);
    const text = p.brief_text ?? p.brief ?? b.summary ?? '';
    if (text) console.log(`    Brief preview: ${String(text).slice(0, 250)}…`);
  } else {
    console.log(`  ⚠ Pas de daily_catalyst_brief dans lisa_decision_log aujourd'hui`);
  }

  // ─── 5. Macro state ───
  console.log('\n\x1b[1m═══ 5. MACRO STATE — dernier snapshot ═══\x1b[0m');
  // Macro = pas de table dédiée. On lit depuis input_state.macro du dernier cycle TRADER.
  if (latest && latest.input_state) {
    const m = (latest.input_state as any).macro;
    if (m && typeof m === 'object') {
      console.log(`  Macro snapshot (depuis input_state du dernier cycle TRADER):`);
      const keys = Object.keys(m);
      console.log(`    Keys: ${keys.join(', ')}`);
      console.log(`    VIX=${m.vix ?? '?'} | DXY=${m.dxy ?? '?'} | US10Y=${m.us10y ?? '?'} | Brent=${m.brent ?? '?'} | Gold=${m.gold ?? '?'}`);
      if (m.regime) console.log(`    Regime: ${m.regime}`);
      if (m.dataQuality) {
        const dq = m.dataQuality;
        console.log(`    Data quality: live=${(dq.live ?? []).length} proxy=${(dq.proxy ?? []).length} fallback=${(dq.fallback ?? []).length}`);
        if ((dq.fallback ?? []).length > 0) console.log(`      ⚠ Fallback: ${(dq.fallback ?? []).join(', ')}`);
      }
    } else {
      console.log(`  ⚠ Pas de macro dans input_state du dernier cycle`);
    }
  } else {
    console.log(`  ⚠ Pas de input_state stocké sur le dernier cycle`);
  }

  // ─── 6. TRADER consume news + macro ? ───
  console.log('\n\x1b[1m═══ 6. TRADER consomme news + macro ? (inspection input_state) ═══\x1b[0m');
  if (latest && latest.input_state) {
    const inp = latest.input_state as Record<string, unknown>;
    const has = (k: string) => inp != null && k in inp;
    console.log(`  Champ macro              : ${has('macro') ? '✓' : '✗'}`);
    console.log(`  Champ news_recent        : ${has('news_recent') ? '✓' : '✗'} (length=${Array.isArray(inp.news_recent) ? (inp.news_recent as unknown[]).length : 0})`);
    console.log(`  Champ daily_brief        : ${has('daily_brief') ? '✓' : '✗'}`);
    console.log(`  Champ scanner_proposals  : ${has('scanner_proposals') ? '✓' : '✗'} (length=${Array.isArray(inp.scanner_proposals) ? (inp.scanner_proposals as unknown[]).length : 0})`);
    console.log(`  Champ risk_advisories    : ${has('risk_advisories') ? '✓' : '✗'} (length=${Array.isArray(inp.risk_advisories) ? (inp.risk_advisories as unknown[]).length : 0})`);
    console.log(`  Champ objectives_progress: ${has('objectives_progress') ? '✓' : '✗'}`);
    if (has('objectives_progress')) {
      const obj = inp.objectives_progress as Record<string, unknown>;
      console.log(`    → target=$${obj.target_daily_usd} realized=$${obj.realized_today_usd} progress=${obj.progress_pct}% status=${obj.trajectory_status} hours=${obj.hours_remaining_in_us_session ?? '?'}h posture=${obj.suggested_risk_posture}`);
    }
    if (has('news_recent') && Array.isArray(inp.news_recent) && (inp.news_recent as unknown[]).length > 0) {
      const sample = (inp.news_recent as Array<any>).slice(0, 3);
      console.log(`\n  News sample (3 premières du dernier cycle):`);
      for (const n of sample) {
        const title = (n.title ?? n.headline ?? '').slice(0, 80);
        const tickers = Array.isArray(n.tickers) ? n.tickers.slice(0,4).join(',') : (n.symbol ?? '?');
        const sentiment = n.sentiment ?? n.score ?? '?';
        console.log(`    [${tickers}] ${title} (sentiment=${sentiment})`);
      }
    }
  }

  // ─── 7. Citations [OBJ_*] ───
  console.log('\n\x1b[1m═══ 7. Citations OBJ_* (preuve consommation objectives) ═══\x1b[0m');
  const { data: cits } = await sb.from('scanner_lesson_citations')
    .select('marker_text, action_kind, decision_decided_at')
    .like('marker_text', '%OBJ_%')
    .gte('decision_decided_at', since1h)
    .limit(20);
  const c = (cits ?? []) as Array<any>;
  if (c.length === 0) console.log(`  Aucune citation OBJ_* sur 1h (peut être normal si trader hold sans citer)`);
  else {
    const byMarker: Record<string, number> = {};
    for (const r of c) byMarker[r.marker_text] = (byMarker[r.marker_text] ?? 0) + 1;
    console.log(`  ${c.length} citations OBJ_* sur 1h: ${Object.entries(byMarker).map(([k,v]) => `${k}×${v}`).join(', ')}`);
  }
}

main().catch(e => { console.error(e); process.exit(2); });
