import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

async function main() {
  console.log('=== 1. Toutes les asset_class dans gainers_user_shadow_signals 60min ===');
  const { data: d1, error: e1 } = await sb
    .from('gainers_user_shadow_signals')
    .select('asset_class')
    .gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString());
  if (e1) console.error(e1.message);
  else {
    const counts: Record<string, number> = {};
    (d1 ?? []).forEach(r => { counts[r.asset_class as string] = (counts[r.asset_class as string] ?? 0) + 1; });
    console.log(counts);
  }

  console.log('\n=== 2. Tous les symbols (top 30 par count) 60min ===');
  const { data: d2 } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol,asset_class,decision,reject_reason')
    .gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString())
    .limit(500);
  const symCounts = new Map<string, { count: number; asset_class: string; decisions: Set<string>; rejects: Set<string> }>();
  (d2 ?? []).forEach(r => {
    const key = r.symbol as string;
    const e = symCounts.get(key) ?? { count: 0, asset_class: r.asset_class as string, decisions: new Set(), rejects: new Set() };
    e.count++;
    e.decisions.add(r.decision as string);
    if (r.reject_reason) e.rejects.add(r.reject_reason as string);
    symCounts.set(key, e);
  });
  [...symCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30)
    .forEach(([sym, s]) => {
      console.log(`  ${sym.padEnd(15)} ${s.asset_class.padEnd(20)} count=${s.count} decisions=${[...s.decisions].join(',')} rejects=${[...s.rejects].join('|')}`);
    });

  console.log('\n=== 3. Toutes les tables top_gainers* / gainers* existantes ===');
  const tables = [
    'top_gainers_log',
    'gainers_v1_shadow_signals',
    'gainers_user_shadow_signals',
    'gainers_persistence_log',
  ];
  for (const t of tables) {
    const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 60 * 60_000).toISOString());
    console.log(`  ${t.padEnd(40)} 60min count=${count ?? 'ERROR:' + error?.message?.slice(0, 50)}`);
  }

  console.log('\n=== 4. top_gainers_log breakdown 30min par asset_class ===');
  const { data: d4, error: e4 } = await sb
    .from('top_gainers_log')
    .select('symbol,asset_class')
    .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .limit(1000);
  if (e4) console.log(`  ERROR: ${e4.message}`);
  else {
    const ac: Record<string, Set<string>> = {};
    (d4 ?? []).forEach(r => {
      const k = r.asset_class as string;
      ac[k] = ac[k] ?? new Set();
      ac[k].add(r.symbol as string);
    });
    Object.entries(ac).forEach(([k, syms]) => {
      console.log(`  ${k.padEnd(20)} ${syms.size} distinct: ${[...syms].sort().slice(0, 20).join(', ')}${syms.size > 20 ? '...' : ''}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
