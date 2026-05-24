/**
 * Pull les derniers 'accept' du scanner par classe pour vérifier pathEff réel.
 */
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 4 * 3600_000).toISOString();
  const { data, error } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, asset_class, path_eff, persistence_score, persistence_count, change_pct_1m, decision, cfg_min_path_eff, created_at')
    .gte('created_at', since)
    .eq('decision', 'accept')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  console.log(`\n=== Derniers ${data?.length ?? 0} 'accept' (4h, par classe) ===\n`);
  for (const r of data ?? []) {
    const at = r.created_at.slice(11, 19);
    console.log(`  ${at}  ${r.symbol.padEnd(10)} ${r.asset_class.padEnd(20)} pathEff=${Number(r.path_eff ?? 0).toFixed(3)} persist=${r.persistence_count ?? '?'} (${Number(r.persistence_score ?? 0).toFixed(2)}) ch1m=${Number(r.change_pct_1m ?? 0).toFixed(2)}% [cfg min=${Number(r.cfg_min_path_eff ?? 0).toFixed(2)}]`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
