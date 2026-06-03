import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // Attendre un nouveau scan post 04:02
  const start = Date.now();
  while (true) {
    const { data } = await sb.from('top_gainers_log')
      .select('captured_at, symbol, decision, market').gt('captured_at', '2026-06-03T04:02:30Z').order('captured_at', { ascending: false }).limit(1).maybeSingle();
    if (data) {
      console.log(`✓ Nouveau scan détecté: ${data.captured_at} ${data.symbol} ${data.decision}`);
      // Re-query les scanner_candidate_skip post ce scan
      await new Promise(r => setTimeout(r, 5_000));
      const { count: skips } = await sb.from('lisa_decision_log')
        .select('*', { count: 'exact', head: true })
        .eq('kind', 'scanner_candidate_skip')
        .gt('timestamp', data.captured_at);
      console.log(`scanner_candidate_skip post ce scan : ${skips ?? 0}`);
      if ((skips ?? 0) > 0) {
        const { data: skipDetail } = await sb.from('lisa_decision_log')
          .select('payload').eq('kind', 'scanner_candidate_skip').gt('timestamp', data.captured_at).limit(20);
        const byGate: Record<string, number> = {};
        for (const s of skipDetail ?? []) {
          const g = String((s.payload as any)?.gate ?? '?');
          byGate[g] = (byGate[g] ?? 0) + 1;
        }
        console.log('Par gate :');
        for (const [k, n] of Object.entries(byGate).sort((a,b) => b[1]-a[1])) console.log(`  ${k}: ${n}`);
      }
      return;
    }
    if (Date.now() - start > 6 * 60_000) { console.log('TIMEOUT 6min'); return; }
    await new Promise(r => setTimeout(r, 30_000));
  }
}
main();
