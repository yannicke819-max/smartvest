import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_]+)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  console.log(`\n=== Recherche legacy GeminiRiskManager activity — 7 derniers jours ===\n`);

  const { data: broken, count } = await sb
    .from('lisa_decision_log')
    .select('summary, payload, created_at', { count: 'exact' })
    .eq('kind', 'risk_manager_thesis_broken')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(20);

  console.log(`risk_manager_thesis_broken : ${count ?? 0} entries 7j`);
  if (broken && broken.length > 0) {
    console.log(`  → Gemini Risk Manager ACTIF :`);
    for (const b of broken.slice(0, 10)) {
      const at = b.created_at.slice(0, 19);
      const conf = b.payload?.confidence ?? '?';
      console.log(`    ${at}  ${b.summary?.slice(0, 90)} (conf=${conf})`);
    }
  } else {
    console.log(`  → Aucune entrée — soit pas de thèses cassées, soit service silencieux`);
  }

  // Aussi le total decision_log toutes catégories (vérifier que le log marche)
  const { count: total } = await sb
    .from('lisa_decision_log')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', since);
  console.log(`\nTotal entries decision_log 7j : ${total ?? 0}`);

  // Distribution des kinds
  const { data: all } = await sb
    .from('lisa_decision_log')
    .select('kind')
    .gte('created_at', since)
    .limit(5000);
  if (all) {
    const map = new Map<string, number>();
    for (const r of all as Array<{ kind: string }>) {
      map.set(r.kind, (map.get(r.kind) ?? 0) + 1);
    }
    console.log(`\nTop kinds 7j (top 15) :`);
    for (const [k, c] of Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(c).padStart(5)}  ${k}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
