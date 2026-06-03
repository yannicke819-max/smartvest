/**
 * Watch post-fix LLM_GATE (commit 92ad65f).
 *
 * Détecte :
 *   - Quand le deploy aboutit (git_sha change)
 *   - Si le LLM gate cesse de rejeter sur changePct seul
 *   - Premier trade ouvert
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

const TARGET_SHA = '92ad65f'; // commit prefix
const startTs = new Date().toISOString();
let deployDetectedAt: string | null = null;

async function checkDeploy(): Promise<string | null> {
  try {
    const r = await fetch('https://smartvest.fly.dev/version');
    const j = await r.json() as { git_sha?: string };
    return j.git_sha ?? null;
  } catch { return null; }
}

async function check(): Promise<boolean> {
  const todayUtc = new Date(); todayUtc.setUTCHours(0,0,0,0);

  const sha = await checkDeploy();
  const deployed = sha?.startsWith(TARGET_SHA) ?? false;
  if (deployed && !deployDetectedAt) {
    deployDetectedAt = new Date().toISOString();
    console.log(`\n🎉 DEPLOY DETECTED at ${deployDetectedAt} — git_sha=${sha?.slice(0,8)}`);
  }

  const { data: llmRejects } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, summary')
    .gte('timestamp', startTs)
    .eq('kind', 'scanner_proposal_rejected_by_llm')
    .order('timestamp', { ascending: false }).limit(20);
  const { data: opens } = await sb.from('lisa_decision_log')
    .select('timestamp, portfolio_id, summary')
    .gte('timestamp', startTs)
    .eq('kind', 'position_opened').limit(20);
  const { data: paper } = await sb.from('paper_trades')
    .select('symbol, opened_at, portfolio_id, size_usd, status')
    .gte('opened_at', todayUtc.toISOString()).limit(20);
  const { data: pos } = await sb.from('lisa_positions')
    .select('symbol, entry_timestamp, status, portfolio_id, entry_notional_usd')
    .gte('entry_timestamp', todayUtc.toISOString()).limit(20);
  const { data: props } = await sb.from('scanner_proposals')
    .select('symbol, status, created_at, direction')
    .gte('created_at', startTs).limit(20);

  const now = new Date().toISOString();
  console.log(`\n[${now.slice(11,19)}] sha=${sha?.slice(0,8) ?? '?'} deployed=${deployed}`);
  console.log(`  LLM rejects post-watch: ${llmRejects?.length ?? 0}`);
  if (llmRejects && llmRejects.length > 0) {
    for (const r of llmRejects.slice(0, 3)) console.log(`    ${r.timestamp.slice(11,19)} ${r.summary?.slice(0,90)}`);
  }
  console.log(`  position_opened events: ${opens?.length ?? 0}`);
  if (opens && opens.length > 0) for (const o of opens.slice(0, 3)) console.log(`    ✅ ${o.timestamp.slice(11,19)} pf=${o.portfolio_id?.slice(0,8)} ${o.summary?.slice(0,90)}`);
  console.log(`  scanner_proposals post-watch: ${props?.length ?? 0}`);
  console.log(`  paper_trades today: ${paper?.length ?? 0}`);
  console.log(`  lisa_positions today: ${pos?.length ?? 0}`);

  // Exit if first trade opened
  return (paper?.length ?? 0) > 0 || (pos?.length ?? 0) > 0 || (opens?.length ?? 0) > 0;
}

(async () => {
  console.log(`Watch post-LLM-fix start ${startTs} — target sha=${TARGET_SHA}`);
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    if (await check()) { console.log('\n=== EXIT — premier trade détecté ==='); process.exit(0); }
    await new Promise(r => setTimeout(r, 30_000));
  }
  console.log('\n=== TIMEOUT 20min ===');
  process.exit(0);
})();
