/**
 * Audit positions ouvertes — source × PnL × distance TP/SL.
 * Cross-référence lisa_positions (status='open') avec lisa_decision_log
 * (kind IN 'position_opened','opportunity_scout_opened') pour identifier
 * la source (scanner gainers vs opportunity scout vs Lisa thesis).
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const todayUtc = new Date();
todayUtc.setUTCHours(0, 0, 0, 0);
const sinceToday = todayUtc.toISOString();

async function main() {
  const now = new Date();
  console.log(`\n=== AUDIT POSITIONS OUVERTES — ${now.toISOString().slice(0,19)} UTC ===\n`);

  // 1. Toutes les positions OPEN
  const { data: positions, error: errPos } = await sb
    .from('lisa_positions')
    .select('id, portfolio_id, symbol, asset_class, direction, entry_price, entry_timestamp, entry_notional_usd, stop_loss_price, take_profit_price, status, proposal_id, thesis_id')
    .eq('status', 'open')
    .order('entry_timestamp', { ascending: false });

  if (errPos) {
    console.error('Erreur DB :', errPos);
    process.exit(1);
  }

  if (!positions || positions.length === 0) {
    console.log('⚠️  Aucune position ouverte actuellement.');
    return;
  }

  console.log(`Total positions ouvertes : ${positions.length}\n`);

  // 2. Pull decision_log entries des dernières 24h pour cross-référence
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: openLogs } = await sb
    .from('lisa_decision_log')
    .select('kind, payload, timestamp, summary')
    .in('kind', ['position_opened', 'opportunity_scout_opened'])
    .gte('timestamp', since24h)
    .order('timestamp', { ascending: false })
    .limit(500);

  // Index par position_id
  const sourceByPositionId = new Map<string, { source: string; kind: string; summary: string }>();
  for (const log of (openLogs ?? []) as any[]) {
    const pid = log.payload?.position_id;
    if (pid && !sourceByPositionId.has(pid)) {
      const source = log.kind === 'opportunity_scout_opened'
        ? '🟢 OPP_SCOUT'
        : (log.payload?.source ?? 'scanner') === 'scanner_top_gainers_direct'
          ? '🎯 SCANNER'
          : '🤖 LISA';
      sourceByPositionId.set(pid, { source, kind: log.kind, summary: log.summary ?? '' });
    }
  }

  // 3. Pour chaque position, fetch live price via lisa_market_quote_cache (ou Binance/EODHD direct)
  console.log('─── DÉTAIL POSITIONS ───');
  console.log('Source     Entrée(UTC)   Symbol            Class            Entry      TP        SL        Notional   Age');
  console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────────');

  const bySource: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  let totalNotional = 0;

  for (const p of positions as any[]) {
    const meta = sourceByPositionId.get(p.id) ?? { source: '❓ INCONNU', kind: '?', summary: '' };
    bySource[meta.source] = (bySource[meta.source] ?? 0) + 1;
    byClass[p.asset_class] = (byClass[p.asset_class] ?? 0) + 1;
    totalNotional += Number(p.entry_notional_usd);

    const ageMin = Math.floor((Date.now() - new Date(p.entry_timestamp).getTime()) / 60_000);
    const ageStr = ageMin < 60 ? `${ageMin}min` : `${Math.floor(ageMin/60)}h${String(ageMin%60).padStart(2,'0')}`;
    const tpDist = p.take_profit_price ? ((Number(p.take_profit_price) - Number(p.entry_price)) / Number(p.entry_price) * 100).toFixed(2) : 'n/a';
    const slDist = p.stop_loss_price ? ((Number(p.stop_loss_price) - Number(p.entry_price)) / Number(p.entry_price) * 100).toFixed(2) : 'n/a';

    console.log(
      `${meta.source.padEnd(11)} ${p.entry_timestamp.slice(11,16)}        ` +
      `${p.symbol.padEnd(16)} ${p.asset_class.padEnd(16)} ` +
      `${Number(p.entry_price).toFixed(4).padStart(9)} ${(tpDist+'%').padStart(8)} ${(slDist+'%').padStart(8)} ` +
      `$${Number(p.entry_notional_usd).toFixed(0).padStart(6)}  ${ageStr}`
    );
  }

  // 4. Récap par source
  console.log('\n─── BREAKDOWN PAR SOURCE ───');
  for (const [src, n] of Object.entries(bySource).sort((a,b)=>(b[1] as number)-(a[1] as number))) {
    console.log(`  ${src.padEnd(13)} : ${n} position(s)`);
  }

  // 5. Récap par asset_class
  console.log('\n─── BREAKDOWN PAR ASSET_CLASS ───');
  for (const [cls, n] of Object.entries(byClass).sort((a,b)=>(b[1] as number)-(a[1] as number))) {
    console.log(`  ${cls.padEnd(20)} : ${n} position(s)`);
  }

  // 6. Capital engagé
  console.log('\n─── CAPITAL ENGAGÉ ───');
  console.log(`  Notional total : $${totalNotional.toFixed(2)}`);
  console.log(`  Moyenne / position : $${(totalNotional/positions.length).toFixed(2)}`);

  // 7. News positives détectées par scout aujourd'hui
  const { data: scoutLogs } = await sb
    .from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'opportunity_scout_opened')
    .gte('timestamp', sinceToday)
    .order('timestamp', { ascending: false });

  if (scoutLogs && scoutLogs.length > 0) {
    console.log(`\n─── OPPORTUNITY SCOUT AUJOURD'HUI (${scoutLogs.length} opens) ───`);
    for (const log of scoutLogs as any[]) {
      const t = log.timestamp.slice(11,16);
      const news = log.payload?.news_title?.slice(0, 80) ?? '?';
      const sector = log.payload?.sector ?? '?';
      const conf = log.payload?.confidence ? Number(log.payload.confidence).toFixed(2) : '?';
      console.log(`  ${t} UTC  ${sector.padEnd(20)} conf=${conf}  news="${news}..."`);
    }
  }

  // 8. RiskManager auto-closes aujourd'hui
  const { data: rmLogs } = await sb
    .from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'risk_manager_thesis_broken')
    .gte('timestamp', sinceToday)
    .order('timestamp', { ascending: false });

  if (rmLogs && rmLogs.length > 0) {
    const closed = (rmLogs as any[]).filter(l => l.payload?.auto_closed === true);
    const shadow = (rmLogs as any[]).filter(l => l.payload?.auto_closed !== true);
    console.log(`\n─── GEMINI RISK MANAGER AUJOURD'HUI ───`);
    console.log(`  Auto-closed : ${closed.length}`);
    console.log(`  Shadow log  : ${shadow.length}`);
    for (const log of closed.slice(0, 10)) {
      const t = log.timestamp.slice(11,16);
      const sym = log.payload?.symbol ?? '?';
      const conf = log.payload?.confidence ? Number(log.payload.confidence).toFixed(2) : '?';
      const reason = log.payload?.reason?.slice(0, 80) ?? '?';
      console.log(`  ${t} UTC  ${sym.padEnd(12)} conf=${conf}  ${reason}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
