import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const TRADER = 'b0000001-0000-0000-0000-000000000001';
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  console.log(`\n═══ Funnel détaillé — ${new Date().toISOString().slice(11,19)} UTC ═══\n`);

  // 1. Toutes les positions ouvertes TRADER right now
  const { data: opens } = await sb
    .from('lisa_positions')
    .select('symbol, venue, entry_price, entry_timestamp, status')
    .eq('portfolio_id', TRADER)
    .in('status', ['open']);
  console.log(`Positions ouvertes TRADER right now: ${opens?.length ?? 0}`);
  for (const o of opens ?? []) {
    console.log(`  ${o.symbol.padEnd(14)} ${o.venue} entry=$${o.entry_price} opened=${o.entry_timestamp?.slice(0,16)}`);
  }

  // 2. scanner_proposals dernières 60min avec scores
  console.log(`\nScanner_proposals 60min :`);
  const { data: props } = await sb
    .from('scanner_proposals')
    .select('symbol, asset_class, score, change_pct, status, created_at')
    .eq('portfolio_id', TRADER)
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  // Group by symbol pour voir score max
  const bySym = new Map<string, { count: number; maxScore: number; latestStatus: string; maxChange: number }>();
  for (const p of props ?? []) {
    const acc = bySym.get(p.symbol) ?? { count: 0, maxScore: 0, latestStatus: '', maxChange: 0 };
    acc.count++;
    acc.maxScore = Math.max(acc.maxScore, Number(p.score ?? 0));
    acc.maxChange = Math.max(acc.maxChange, Number(p.change_pct ?? 0));
    acc.latestStatus = p.status ?? 'NULL';
    bySym.set(p.symbol, acc);
  }
  console.log(`  Total proposals: ${props?.length ?? 0}, unique symbols: ${bySym.size}`);
  for (const [sym, s] of [...bySym].sort((a,b) => b[1].maxScore - a[1].maxScore)) {
    const bypassFlag = s.maxScore >= 0.5 ? '✅ ≥0.5 bypass' : (s.maxScore >= 0.3 ? '🟡 0.3-0.5' : '⚪ <0.3');
    console.log(`  ${sym.padEnd(14)} ${s.count.toString().padStart(2)}× maxScore=${s.maxScore.toFixed(2)} maxChange=${s.maxChange.toFixed(1)}% latest=${s.latestStatus.padEnd(12)} ${bypassFlag}`);
  }

  // 3. Shadow signals 60min — détail EU pour les rejects
  console.log(`\nShadow signals EU 60min — par decision :`);
  const { data: shadowEU } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, decision, entry_price')
    .eq('asset_class', 'eu_equity')
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  const decCounts = new Map<string, Array<string>>();
  for (const s of shadowEU ?? []) {
    if (!decCounts.has(s.decision)) decCounts.set(s.decision, []);
    decCounts.get(s.decision)!.push(s.symbol);
  }
  for (const [d, syms] of decCounts) {
    const uniq = [...new Set(syms)];
    console.log(`  ${d.padEnd(28)} ${syms.length.toString().padStart(3)} (${uniq.length} unique): ${uniq.slice(0,5).join(',')}`);
  }

  // 4. Si 0P4G.LSE ou 0ROY.LSE existent
  console.log(`\nRecherche 0P4G.LSE et 0ROY.LSE dans shadow_signals 60min :`);
  const { data: searches } = await sb
    .from('gainers_user_shadow_signals')
    .select('symbol, asset_class, decision, entry_price, created_at')
    .or('symbol.eq.0P4G.LSE,symbol.eq.0ROY.LSE,symbol.ilike.0P4G%,symbol.ilike.0ROY%')
    .gte('created_at', since);
  console.log(`  Found: ${searches?.length ?? 0}`);
  for (const s of searches ?? []) {
    console.log(`    ${s.created_at?.slice(11,19)} ${s.symbol} ${s.asset_class} ${s.decision} entry=$${s.entry_price}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
