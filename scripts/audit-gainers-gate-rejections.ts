/**
 * Distribution des rejets par gate sur le scanner gainers.
 *
 * Analyse les kinds dans lisa_decision_log qui correspondent à des skips :
 *   - scanner_candidate_skip  (pré-filter persistence, path_eff, cooldown, etc.)
 *   - position_open_failed    (TOP_TICK_GUARD, STALE_GUARD, etc.)
 *   - skeptic_verdict         (debate-gate consensus WAIT)
 *   - lesson_needs_manual_review
 *
 * Extrait la raison du skip depuis summary/payload et compte par catégorie.
 *
 *   npx tsx scripts/audit-gainers-gate-rejections.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TRADER = 'b0000001-0000-0000-0000-000000000001';
const MIDDLE = 'a0000002-0000-0000-0000-000000000002';
const SMALL = 'a0000003-0000-0000-0000-000000000003';
const PORTFOLIOS = [TRADER, MIDDLE, SMALL];
const NAMES: Record<string, string> = { [TRADER]: 'TRADER', [MIDDLE]: 'MIDDLE', [SMALL]: 'SMALL' };

function pad(s: unknown, n: number) { return String(s ?? '').padEnd(n).slice(0, n); }
function fmtT(v: unknown) { return String(v ?? '').replace('T', ' ').slice(0, 16); }

/** Extrait le tag de gate depuis le summary/rationale. */
function extractGate(summary: string, kind: string): string {
  // Pattern : [GATE_NAME] ou skipped GATE_NAME ou raison "X"
  const tagMatch = summary.match(/\[([A-Z_]+)\]/);
  if (tagMatch) return tagMatch[1];
  if (kind === 'skeptic_verdict') return 'SKEPTIC_GATE';
  if (kind === 'lesson_needs_manual_review') return 'LESSON_REVIEW';
  // Pattern alt : "skipped (reason)" ou "skip because X"
  const skipMatch = summary.match(/skip[^a-z]*[^(]*\(([^)]+)\)/i);
  if (skipMatch) return skipMatch[1].trim().toUpperCase().replace(/\s+/g, '_').slice(0, 30);
  // Pattern alt : "rejected (quality=0.30): Negative momentum"
  const rejectedMatch = summary.match(/rejected\s*\(([^)]+)\)/i);
  if (rejectedMatch) return `REJECTED:${rejectedMatch[1].slice(0, 25)}`;
  return 'OTHER';
}

async function main() {
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const since6h = new Date(Date.now() - 6 * 3600_000).toISOString();

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(' DISTRIBUTION REJETS PAR GATE — gainers (24h + 6h)');
  console.log('═══════════════════════════════════════════════════════════════════════════════');

  for (const window of [
    { label: '24h', since: since24h },
    { label: '6h', since: since6h },
  ]) {
    console.log(`\n──── Fenêtre ${window.label} ────`);

    const { data: events } = await sb
      .from('lisa_decision_log')
      .select('timestamp, kind, portfolio_id, summary, payload')
      .in('portfolio_id', PORTFOLIOS)
      .in('kind', ['scanner_candidate_skip', 'position_open_failed', 'skeptic_verdict', 'lesson_needs_manual_review'])
      .gte('timestamp', window.since)
      .limit(5000);

    console.log(`  Total skips/rejects : ${events?.length ?? 0}`);
    if (!events?.length) continue;

    // Aggregate by gate
    const byGate = new Map<string, { n: number; pfs: Map<string, number> }>();
    const byKind = new Map<string, number>();
    for (const e of events) {
      const summary = String(e.summary ?? '');
      const gate = extractGate(summary, e.kind as string);
      const pfName = NAMES[e.portfolio_id as string];
      const acc = byGate.get(gate) ?? { n: 0, pfs: new Map() };
      acc.n++;
      acc.pfs.set(pfName, (acc.pfs.get(pfName) ?? 0) + 1);
      byGate.set(gate, acc);
      byKind.set(e.kind as string, (byKind.get(e.kind as string) ?? 0) + 1);
    }

    // Distribution par kind
    console.log(`\n  Par kind :`);
    for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${pad(k, 35)} → ${n}`);
    }

    // Distribution par gate (TOP 20)
    console.log(`\n  Par gate (TOP 20, breakdown par portfolio) :`);
    const sorted = [...byGate].sort((a, b) => b[1].n - a[1].n);
    for (const [gate, { n, pfs }] of sorted.slice(0, 20)) {
      const breakdown = [...pfs].map(([p, c]) => `${p}=${c}`).join(' ');
      console.log(`    ${pad(gate, 30)} → ${pad(n, 4)}  (${breakdown})`);
    }

    // 5 exemples plus récents pour les top 3 gates
    if (window.label === '6h') {
      console.log(`\n  Échantillons (3 plus récents par gate du TOP 5) :`);
      for (const [gate, { n }] of sorted.slice(0, 5)) {
        const samples = events.filter(e => extractGate(String(e.summary ?? ''), e.kind as string) === gate).slice(-3);
        for (const s of samples) {
          console.log(`    [${gate}] ${fmtT(s.timestamp)} ${pad(NAMES[s.portfolio_id as string], 8)} ${String(s.summary ?? '').slice(0, 100)}`);
        }
      }
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
