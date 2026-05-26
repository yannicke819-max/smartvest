import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => { const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc; }, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
(async () => {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data } = await sb.from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, change_pct_1m, score, path_eff, persistence_score, persistence_count, cfg_min_path_eff, created_at')
    .eq('asset_class', 'eu_equity').gte('created_at', since).order('created_at', { ascending: false }).limit(10);
  console.log(`EU signals last 15min: ${data?.length ?? 0}\n`);
  if (data) for (const s of data as any[]) {
    console.log(`${s.created_at?.slice(11,19)} ${s.symbol.padEnd(15)} dec=${s.decision.padEnd(28)} chg=${s.change_pct_1m}% path=${s.path_eff} pers=${s.persistence_count} score=${s.score}`);
  }
})();
