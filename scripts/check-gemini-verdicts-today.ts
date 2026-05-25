import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const since = new Date(); since.setUTCHours(0, 0, 0, 0);

(async () => {
  console.log(`\n=== AUDIT GEMINI V2 RISK MANAGER — ${new Date().toISOString().slice(0,19)} UTC ===\n`);

  // 1. Tous les verdicts risk_manager_thesis_broken aujourd'hui
  const { data: rm } = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'risk_manager_thesis_broken')
    .gte('timestamp', since.toISOString())
    .order('timestamp', { ascending: false })
    .limit(100);

  if (!rm || rm.length === 0) {
    console.log('0 entries risk_manager_thesis_broken aujourd\'hui.');
    console.log('Possibles raisons :');
    console.log('  - V2 RM ne détecte aucune thèse cassée (toutes "valid" ou "unclear")');
    console.log('  - V2 RM ne tourne pas (flag GEMINI_RISK_MANAGER_ENABLED off ?)');
    console.log('  - Migration 0164 pas appliquée (CHECK constraint rejette toujours ?)');
    return;
  }

  console.log(`Total verdicts (broken conf>=0.7) : ${rm.length}\n`);

  let autoClosed = 0;
  let shadow = 0;
  const bySymbol: Record<string, { count: number; closes: number; maxConf: number; reasons: string[] }> = {};
  for (const r of rm as any[]) {
    const isAutoClose = r.payload?.auto_closed === true;
    if (isAutoClose) autoClosed++; else shadow++;
    const sym = r.payload?.symbol ?? '?';
    if (!bySymbol[sym]) bySymbol[sym] = { count: 0, closes: 0, maxConf: 0, reasons: [] };
    bySymbol[sym].count++;
    if (isAutoClose) bySymbol[sym].closes++;
    const conf = Number(r.payload?.confidence ?? 0);
    if (conf > bySymbol[sym].maxConf) bySymbol[sym].maxConf = conf;
    const reason = r.payload?.reason ?? '?';
    if (!bySymbol[sym].reasons.includes(reason)) bySymbol[sym].reasons.push(reason);
  }
  console.log(`  Auto-closed : ${autoClosed}  ·  Shadow log only : ${shadow}\n`);
  console.log('Par symbol (top 10) :');
  for (const [sym, s] of Object.entries(bySymbol).sort((a,b) => b[1].count - a[1].count).slice(0, 10)) {
    console.log(`  ${sym.padEnd(15)} count=${s.count} closes=${s.closes} maxConf=${s.maxConf.toFixed(2)} reasons=${s.reasons.slice(0, 2).join(' | ').slice(0, 100)}`);
  }

  // 2. Compte risk_monitor_action aujourd'hui (Open Position Risk Monitor avec verdicts HOLD)
  const { data: rmon } = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'risk_monitor_action')
    .gte('timestamp', since.toISOString())
    .order('timestamp', { ascending: false })
    .limit(50);
  console.log(`\nrisk_monitor_action (Open Position Risk Monitor) aujourd'hui : ${rmon?.length ?? 0}`);
  if (rmon && rmon.length > 0) {
    const verdictCount: Record<string, number> = {};
    for (const r of rmon as any[]) {
      const v = r.payload?.verdict ?? r.payload?.action ?? 'unknown';
      verdictCount[v] = (verdictCount[v] ?? 0) + 1;
    }
    for (const [v, n] of Object.entries(verdictCount).sort((a,b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${v}`);
    }
  }

  // 3. opportunity_scout_opened aujourd'hui
  const { data: scout } = await sb.from('lisa_decision_log')
    .select('timestamp, summary, payload')
    .eq('kind', 'opportunity_scout_opened')
    .gte('timestamp', since.toISOString())
    .order('timestamp', { ascending: false });
  console.log(`\nopportunity_scout_opened aujourd'hui : ${scout?.length ?? 0}`);
  if (scout && scout.length > 0) {
    for (const s of scout as any[]) {
      console.log(`  ${s.timestamp.slice(11,19)} ${s.payload?.proxy} sector=${s.payload?.sector} conf=${s.payload?.confidence}`);
    }
  }
})();
