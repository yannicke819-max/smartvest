import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { count: act } = await sb.from('scanner_lessons').select('*', { count: 'exact', head: true }).eq('is_active', true);
  console.log('is_active=true count:', act);
  const { data } = await sb
    .from('scanner_lessons')
    .select('lesson_kind,scope,confidence,sample_size,win_rate_observed,avg_pnl_usd,lesson_text,proposed_config_change,applied,derived_from_date')
    .eq('is_active', true)
    .order('confidence', { ascending: false })
    .limit(200);
  console.log('Total fetched:', data?.length);
  console.log();

  const matches = (data ?? []).filter((l: any) => {
    const txt = (l.lesson_text + ' ' + (l.scope ?? '') + ' ' + JSON.stringify(l.proposed_config_change ?? '')).toLowerCase();
    return (
      txt.includes('crypto') ||
      txt.includes('binance') ||
      txt.includes('bnb') ||
      txt.includes('btcusdt') ||
      txt.includes('ethusdt') ||
      txt.includes('stale') ||
      txt.includes('websocket') ||
      txt.includes('ws_state') ||
      txt.includes('liquidity') ||
      txt.includes('persistence') ||
      txt.includes('ws ')
    );
  });
  console.log('=== Crypto/Binance/Stale/Liquidity/Persistence — ' + matches.length + ' matches ===');
  matches.slice(0, 25).forEach((l: any, i: number) => {
    console.log(`${i + 1}. [${l.lesson_kind}] scope=${l.scope ?? '-'} conf=${(l.confidence ?? 0).toFixed?.(2) ?? '?'} n=${l.sample_size} winR=${(l.win_rate_observed ?? 0).toFixed?.(2) ?? '?'} pnl=${(l.avg_pnl_usd ?? 0).toFixed?.(2) ?? '?'} applied=${l.applied}`);
    console.log(`   from: ${l.derived_from_date}`);
    console.log(`   text: ${(l.lesson_text ?? '').slice(0, 220)}`);
    if (l.proposed_config_change) console.log(`   cfg : ${JSON.stringify(l.proposed_config_change).slice(0, 200)}`);
  });
  console.log();
  console.log('=== Top 15 lessons toutes scopes par confidence ===');
  (data ?? []).slice(0, 15).forEach((l: any, i: number) => {
    console.log(`${i + 1}. [${l.lesson_kind}] scope=${l.scope ?? '-'} conf=${(l.confidence ?? 0).toFixed?.(2) ?? '?'} n=${l.sample_size}  ${(l.lesson_text ?? '').slice(0, 140)}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
