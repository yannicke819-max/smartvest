import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function waitBoot(since: string, maxMinutes: number): Promise<boolean> {
  const start = Date.now();
  while (true) {
    const { data } = await sb.from('trader_agent_decisions')
      .select('cycle_started_at')
      .eq('portfolio_id', 'b0000001-0000-0000-0000-000000000001')
      .like('thesis', '[BOOT_SENTINEL]%')
      .gt('cycle_started_at', since)
      .order('cycle_started_at', { ascending: false })
      .limit(1).maybeSingle();
    if (data) {
      console.log(`✓ BOOT detected at ${data.cycle_started_at}`);
      return true;
    }
    if ((Date.now() - start) / 60000 > maxMinutes) return false;
    await new Promise(r => setTimeout(r, 30_000));
  }
}

async function reportSkips(since: string) {
  const { data: skips, count } = await sb.from('lisa_decision_log')
    .select('payload', { count: 'exact' })
    .eq('kind', 'scanner_candidate_skip')
    .gte('timestamp', since);
  console.log(`\n📊 Skip events scanner_candidate_skip depuis ${since.slice(11,19)} UTC : ${count}`);
  if (!skips || skips.length === 0) return;

  // Aggrégation par gate
  const byGate: Record<string, number> = {};
  const byGateReason: Record<string, number> = {};
  const byGateAc: Record<string, Record<string, number>> = {};
  const sampleBySymbol: Record<string, { gate: string; reason: string; cnt: number }> = {};
  for (const s of skips) {
    const p = s.payload as any;
    const gate = String(p?.gate ?? 'unknown');
    const reason = String(p?.reason ?? '?');
    const ac = String(p?.asset_class ?? '?');
    const sym = String(p?.symbol ?? '?');
    byGate[gate] = (byGate[gate] ?? 0) + 1;
    byGateReason[`${gate}|${reason}`] = (byGateReason[`${gate}|${reason}`] ?? 0) + 1;
    if (!byGateAc[gate]) byGateAc[gate] = {};
    byGateAc[gate][ac] = (byGateAc[gate][ac] ?? 0) + 1;
    if (!sampleBySymbol[sym]) sampleBySymbol[sym] = { gate, reason, cnt: 0 };
    sampleBySymbol[sym].cnt++;
  }
  console.log('\n🚨 PAR GATE (top tueur):');
  for (const [k, n] of Object.entries(byGate).sort((a,b) => b[1]-a[1])) console.log(`  ${k.padEnd(25)} ${n}`);
  console.log('\n📋 PAR GATE × RAISON:');
  for (const [k, n] of Object.entries(byGateReason).sort((a,b) => b[1]-a[1]).slice(0, 15)) console.log(`  ${k.padEnd(60)} ${n}`);
  console.log('\n🌍 PAR GATE × ASSET_CLASS:');
  for (const [gate, byAc] of Object.entries(byGateAc)) {
    const detail = Object.entries(byAc).sort((a,b) => b[1]-a[1]).map(([ac, n]) => `${ac}=${n}`).join(', ');
    console.log(`  ${gate.padEnd(20)} ${detail}`);
  }
  console.log('\n🎯 TOP 10 SYMBOLES SKIPPED:');
  const top = Object.entries(sampleBySymbol).sort((a,b) => b[1].cnt - a[1].cnt).slice(0, 10);
  for (const [sym, info] of top) console.log(`  ${sym.padEnd(18)} skipped ${info.cnt}x — last gate=${info.gate} reason=${info.reason}`);
}

async function main() {
  const SINCE_DEPLOY = '2026-06-03T03:55:00Z'; // post-merge time
  console.log(`Waiting for Fly boot post PR #584 merge...`);
  const booted = await waitBoot(SINCE_DEPLOY, 12);
  if (!booted) { console.log('TIMEOUT boot 12min — Fly might be stuck'); return; }

  console.log(`\nFly UP. Wait 4 min pour accumulation data...`);
  await new Promise(r => setTimeout(r, 4 * 60_000));

  const SINCE_REPORT = new Date(Date.now() - 5 * 60_000).toISOString();
  await reportSkips(SINCE_REPORT);

  console.log('\n✅ Mission pépites — analyse terminée. Voir résultats ci-dessus.');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
