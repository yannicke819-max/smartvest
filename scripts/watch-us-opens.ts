import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((a:any,l)=>{const m=l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);if(m)a[m[1]]=m[2];return a;},{});
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const PID = '58439d86-3f20-4a60-82a4-307f3f252bc2';
const sinceDeploy = '2026-05-26T17:05:34Z';
const seen = new Set<string>();
(async () => {
  console.log(`Watch US opens since deploy 17:05:34 UTC. Poll 20s.`);
  for (let i = 0; i < 60; i++) { // 20min
    const { data: dl } = await sb.from('lisa_decision_log')
      .select('id, kind, summary, timestamp')
      .eq('portfolio_id', PID).gte('timestamp', sinceDeploy)
      .order('timestamp', { ascending: true }).limit(50);
    const fresh = (dl ?? []).filter((e:any) => !seen.has(e.id));
    for (const e of fresh as any[]) {
      seen.add(e.id);
      const isUs = /\.US/i.test(e.summary ?? '');
      const tag = e.kind === 'position_opened' ? (isUs ? '🟢 US OPEN' : '⚪ open') :
                  e.kind === 'position_open_failed' ? (isUs ? '🔴 US FAIL' : '⚪ fail') :
                  e.kind === 'position_closed' ? '⚫ close' : `· ${e.kind}`;
      console.log(`${tag} ${e.timestamp.slice(11,19)} ${(e.summary ?? '').slice(0,90)}`);
    }
    if (i % 5 === 0) {
      const { data: open } = await sb.from('lisa_positions').select('symbol').eq('portfolio_id', PID).eq('status','open');
      const usCount = (open ?? []).filter((p:any) => p.symbol.endsWith('.US')).length;
      console.log(`[${new Date().toISOString().slice(11,19)}] open=${(open ?? []).length} (US=${usCount})`);
    }
    await new Promise(r => setTimeout(r, 20000));
  }
})();
