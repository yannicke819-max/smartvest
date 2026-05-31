import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
);

async function main() {
  // 30 min window — post-deploy 11:07 UTC, we're at 11:17+
  const since30 = new Date(Date.now() - 30 * 60_000).toISOString();

  console.log('=== gainers_v1_shadow_signals 30min — schema discovery ===');
  const { data: d0 } = await sb.from('gainers_v1_shadow_signals').select('*').limit(1);
  console.log('Columns:', d0?.[0] ? Object.keys(d0[0]).join(', ') : '(empty)');

  console.log('\n=== distinct symbols 30min ===');
  const { data: d1 } = await sb
    .from('gainers_v1_shadow_signals')
    .select('symbol')
    .gte('created_at', since30)
    .limit(2000);
  const syms = new Set((d1 ?? []).map(r => r.symbol as string));
  console.log(`Total signals=${d1?.length}, distinct symbols=${syms.size}`);
  console.log('Symbols:', [...syms].sort().join(', '));

  console.log('\n=== top_gainers_log distinct symbols 30min ===');
  const { data: d2 } = await sb
    .from('top_gainers_log')
    .select('symbol')
    .gte('created_at', since30)
    .limit(2000);
  const syms2 = new Set((d2 ?? []).map(r => r.symbol as string));
  console.log(`Total entries=${d2?.length}, distinct symbols=${syms2.size}`);
  const altsTracked = ['LTCUSDT', 'BCHUSDT', 'ETCUSDT', 'NEARUSDT', 'ATOMUSDT', 'UNIUSDT', 'ICPUSDT', 'APTUSDT', 'XLMUSDT', 'FILUSDT', 'ARBUSDT', 'OPUSDT', 'INJUSDT', 'AAVEUSDT', 'SUIUSDT', 'TIAUSDT', 'RNDRUSDT', 'IMXUSDT'];
  const altsFound = altsTracked.filter(a => syms2.has(a));
  console.log(`Alts CRYPTO_ALTS dans top_gainers_log: ${altsFound.length}/18 — ${altsFound.join(', ') || '(aucun)'}`);
  console.log(`All distinct: ${[...syms2].sort().slice(0, 50).join(', ')}${syms2.size > 50 ? '...' : ''}`);

  console.log('\n=== gainers_persistence_log 30min ===');
  const { data: d3 } = await sb
    .from('gainers_persistence_log')
    .select('*')
    .gte('created_at', since30)
    .limit(50);
  if (d3?.[0]) {
    console.log('Schema:', Object.keys(d3[0]).join(', '));
    const syms3 = new Set(d3.map(r => (r as any).symbol as string));
    console.log(`Distinct symbols=${syms3.size}: ${[...syms3].sort().join(', ')}`);
  } else {
    console.log('(empty)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
