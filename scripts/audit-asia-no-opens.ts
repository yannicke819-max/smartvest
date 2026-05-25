/**
 * Audit : pourquoi aucune ouverture Asia depuis 1h ?
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const since1h = new Date(Date.now() - 60 * 60_000).toISOString();
const since6h = new Date(Date.now() - 6 * 60 * 60_000).toISOString();

async function main() {
  const nowUtc = new Date();
  const hourUtc = nowUtc.getUTCHours();
  console.log(`\n=== AUDIT ASIA NO-OPENS — ${nowUtc.toISOString().slice(0, 19)} UTC (heure=${hourUtc}h) ===\n`);

  // ── 1. Heure UTC courante vs fenêtres Asia ────────────────────────────────
  console.log('─── 1. HEURE UTC & FENÊTRES MARCHÉ ASIA ───');
  const markets = [
    { name: 'Korea (KRX)',   open: 0,  close: 6,  suffix: '.KO' },
    { name: 'HK (HKEX)',     open: 1,  close: 8,  suffix: '.HK' },
    { name: 'Tokyo (TSE)',   open: 0,  close: 6,  suffix: '.T'  },
    { name: 'Shanghai/SHG', open: 1,  close: 7,  suffix: '.SHG' },
  ];
  for (const m of markets) {
    const open = hourUtc >= m.open && hourUtc < m.close;
    console.log(`  ${m.name.padEnd(20)} ${m.open}h-${m.close}h UTC  → ${open ? '🟢 OUVERT' : '🔴 FERMÉ'} (maintenant ${hourUtc}h UTC)`);
  }

  // ── 2. Config portfolios gainers ──────────────────────────────────────────
  console.log('\n─── 2. CONFIG PORTFOLIOS GAINERS ───');
  const { data: cfgs } = await sb
    .from('lisa_session_configs')
    .select('portfolio_id, strategy_mode, gainers_cycle_minutes, gainers_min_path_efficiency, gainers_min_persistence_score, autopilot_enabled, kill_switch_active, autopilot_paused_reason')
    .eq('strategy_mode', 'gainers');
  console.log(`  Portfolios en mode gainers : ${cfgs?.length ?? 0}`);
  for (const c of (cfgs ?? []) as any[]) {
    console.log(`  portfolio=${c.portfolio_id.slice(0,8)} cycle=${c.gainers_cycle_minutes}min pathEff≥${c.gainers_min_path_efficiency ?? 'null'} persist≥${c.gainers_min_persistence_score ?? 'null'} autopilot=${c.autopilot_enabled} kill=${c.kill_switch_active} paused=${c.autopilot_paused_reason ?? 'none'}`);
  }

  // ── 3. Positions actuellement ouvertes (Asia) ─────────────────────────────
  console.log('\n─── 3. POSITIONS OUVERTES (toutes + Asia) ───');
  const { data: opens } = await sb
    .from('lisa_positions')
    .select('symbol, direction, entry_timestamp, status')
    .eq('status', 'open');
  console.log(`  Total positions ouvertes : ${opens?.length ?? 0}`);
  const asiaOpen = (opens ?? []).filter((p: any) => /\.(KO|KQ|HK|T|SHG|SHE)$/.test(p.symbol));
  console.log(`  Positions ouvertes ASIA : ${asiaOpen.length}`);
  for (const p of asiaOpen as any[]) {
    const age = Math.round((Date.now() - new Date(p.entry_timestamp).getTime()) / 60_000);
    console.log(`    ${p.symbol.padEnd(15)} ${p.direction} age=${age}min`);
  }

  // ── 4. Shadow signals Asia 1h ─────────────────────────────────────────────
  console.log('\n─── 4. SHADOW SIGNALS ASIA (1h) ───');
  const { data: shadows, count: shadowCount } = await sb
    .from('gainers_v1_shadow_signals')
    .select('symbol, exchange, decision, created_at, path_efficiency, persistence_score', { count: 'exact' })
    .gte('created_at', since1h)
    .or('exchange.eq.KO,exchange.eq.KQ,exchange.eq.HK,exchange.eq.T,exchange.eq.SHG,exchange.eq.SHE')
    .order('created_at', { ascending: false })
    .limit(30);
  console.log(`  Signaux shadow Asia 1h : ${shadowCount ?? 0}`);
  if (shadows && shadows.length > 0) {
    const decisions = (shadows as any[]).reduce((acc: any, s: any) => { acc[s.decision] = (acc[s.decision] ?? 0) + 1; return acc; }, {});
    console.log(`  Répartition décisions : ${JSON.stringify(decisions)}`);
    console.log(`  Derniers 10 :`);
    for (const s of (shadows as any[]).slice(0, 10)) {
      console.log(`    ${s.created_at.slice(11, 19)} ${s.symbol.padEnd(15)} ${s.decision.padEnd(8)} pathEff=${s.path_efficiency ?? '?'} persist=${s.persistence_score ?? '?'}`);
    }
  } else {
    console.log('  ⚠️  AUCUN signal shadow Asia depuis 1h → scanner n\'a pas produit de candidats Asia');
  }

  // ── 5. Decision log 1h — kinds liés aux gainers ──────────────────────────
  console.log('\n─── 5. DECISION_LOG GAINERS (1h) ───');
  const { data: dlogs } = await sb
    .from('lisa_decision_log')
    .select('kind, summary, created_at')
    .gte('created_at', since1h)
    .or('kind.like.%gainers%,kind.like.%scanner%,kind.like.%top_gainer%,kind.like.%hour_gate%,kind.like.%path_eff%,kind.like.%persist%,kind.like.%autopilot%')
    .order('created_at', { ascending: false })
    .limit(30);
  if (!dlogs || dlogs.length === 0) {
    console.log('  Aucune entrée decision_log gainers/scanner depuis 1h');
  } else {
    const byKind: Record<string, number> = {};
    for (const d of dlogs as any[]) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    console.log(`  Par kind : ${JSON.stringify(byKind)}`);
    console.log('  Dernières 10 entrées :');
    for (const d of (dlogs as any[]).slice(0, 10)) {
      console.log(`    ${d.created_at.slice(11, 19)} [${d.kind}] ${(d.summary ?? '').slice(0, 80)}`);
    }
  }

  // ── 6. EODHD calls Asia 1h (eodhd_request_log) ───────────────────────────
  console.log('\n─── 6. EODHD CALLS ASIA (1h) ───');
  const { data: eodCalls, count: eodCount } = await sb
    .from('eodhd_request_log')
    .select('ticker, called_by, success, http_status, timestamp', { count: 'exact' })
    .gte('timestamp', since1h)
    .or('ticker.like.%.KO,ticker.like.%.KQ,ticker.like.%.HK,ticker.like.%.T,ticker.like.%.SHG,ticker.like.%.SHE')
    .order('timestamp', { ascending: false })
    .limit(30);
  console.log(`  Appels EODHD Asia 1h : ${eodCount ?? 0}`);
  if (eodCalls && eodCalls.length > 0) {
    const byCaller: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const c of eodCalls as any[]) {
      byCaller[c.called_by ?? '?'] = (byCaller[c.called_by ?? '?'] ?? 0) + 1;
      const st = c.success ? 'ok' : `fail(${c.http_status ?? '?'})`;
      byStatus[st] = (byStatus[st] ?? 0) + 1;
    }
    console.log(`  Par caller : ${JSON.stringify(byCaller)}`);
    console.log(`  Par statut : ${JSON.stringify(byStatus)}`);
    console.log('  Derniers 10 :');
    for (const c of (eodCalls as any[]).slice(0, 10)) {
      console.log(`    ${c.timestamp.slice(11, 19)} ${c.ticker.padEnd(20)} ${c.called_by?.padEnd(20) ?? '?'} ok=${c.success}`);
    }
  } else {
    console.log('  ⚠️  AUCUN appel EODHD Asia depuis 1h');
  }

  // ── 7. Lisa positions ouvertes récentes Asia (6h) ────────────────────────
  console.log('\n─── 7. DERNIÈRES POSITIONS ASIA OUVERTES (6h) ───');
  const { data: recentPos } = await sb
    .from('lisa_positions')
    .select('symbol, direction, entry_timestamp, status, realized_pnl_usd')
    .gte('entry_timestamp', since6h)
    .or('symbol.like.%.KO,symbol.like.%.KQ,symbol.like.%.HK,symbol.like.%.T,symbol.like.%.SHG,symbol.like.%.SHE')
    .order('entry_timestamp', { ascending: false })
    .limit(10);
  console.log(`  Positions Asia ouvertes ces 6h : ${recentPos?.length ?? 0}`);
  for (const p of (recentPos ?? []) as any[]) {
    console.log(`    ${p.entry_timestamp.slice(11, 19)} ${p.symbol.padEnd(15)} ${p.direction} ${p.status} pnl=${p.realized_pnl_usd ?? '?'}`);
  }

  // ── 8. Gainers scan log (table dédiée si elle existe) ────────────────────
  console.log('\n─── 8. GAINERS_V1_SCAN_LOG (1h, si table existe) ───');
  const { data: scanLog, error: scanErr } = await sb
    .from('gainers_v1_scan_log')
    .select('portfolio_id, scanned_at, candidates_total, candidates_accepted, skipped_hour_gate, skipped_path_eff, skipped_persistence, skipped_blacklist, markets')
    .gte('scanned_at', since1h)
    .order('scanned_at', { ascending: false })
    .limit(15);
  if (scanErr) {
    console.log(`  Table gainers_v1_scan_log inexistante ou erreur : ${scanErr.message}`);
  } else {
    console.log(`  Entrées scan_log 1h : ${scanLog?.length ?? 0}`);
    for (const s of (scanLog ?? []) as any[]) {
      console.log(`    ${s.scanned_at?.slice(11, 19)} total=${s.candidates_total} accepted=${s.candidates_accepted} hour_gate=${s.skipped_hour_gate} path=${s.skipped_path_eff} persist=${s.skipped_persistence} blacklist=${s.skipped_blacklist} markets=${JSON.stringify(s.markets)}`);
    }
  }

  console.log('\n=== FIN AUDIT ===\n');
}
main().catch((e) => { console.error(e); process.exit(1); });
