/**
 * Réparation one-shot du hash chain lisa_decision_log pour TRADER (b0000001).
 *
 * Reproduit la logique de DecisionLogService.repairChainCanonical (TS-side
 * canonical helpers — JAMAIS via repair_lisa_decision_log_chain() SQL qui
 * utilise payload::text + timestamp::text et produit des hashs incompatibles
 * avec verifyChain() côté Node).
 *
 * Usage : pnpm tsx scripts/repair-hash-chain-trader.ts [--dry-run]
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import * as fs from 'fs';

const env = fs.readFileSync('.env', 'utf8').split('\n').reduce((acc, l) => {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/); if (m) acc[m[1]] = m[2]; return acc;
}, {} as Record<string, string>);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!);
const DRY_RUN = process.argv.includes('--dry-run');
const PORTFOLIO_ARG = process.argv.find((a) => a.startsWith('--portfolio='))?.slice('--portfolio='.length);
const TRADER = PORTFOLIO_ARG ?? 'b0000001-0000-0000-0000-000000000001';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}
function canonicalTimestamp(ts: string): string { return new Date(ts).toISOString(); }

(async () => {
  console.log(`[repair-hash-chain] portfolio=${TRADER} dry_run=${DRY_RUN}`);
  const { data: entries, error } = await sb.from('lisa_decision_log')
    .select('id, kind, summary, rationale, payload, hash_chain_current, hash_chain_prev, timestamp')
    .eq('portfolio_id', TRADER)
    .order('timestamp', { ascending: true });
  if (error || !entries) { console.error('Fetch error:', error); process.exit(1); }
  console.log(`Total entries: ${entries.length}`);

  let prevHash: string | null = null;
  let firstCorruptedIndex: number | null = null;
  let repaired = 0;
  const toUpdate: Array<{ id: string; hash_chain_current: string; hash_chain_prev: string | null }> = [];

  for (let i = 0; i < entries.length; i++) {
    const e: any = entries[i];
    const input = [
      prevHash ?? 'GENESIS',
      e.kind, e.summary, e.rationale,
      canonicalJson(e.payload),
      canonicalTimestamp(e.timestamp),
    ].join('|');
    const newHash = createHash('sha256').update(input).digest('hex');

    if (e.hash_chain_current !== newHash || e.hash_chain_prev !== prevHash) {
      if (firstCorruptedIndex === null) firstCorruptedIndex = i;
      toUpdate.push({ id: e.id, hash_chain_current: newHash, hash_chain_prev: prevHash });
      repaired++;
    }
    prevHash = newHash;
  }

  console.log(`First corrupted index: ${firstCorruptedIndex}`);
  console.log(`Entries to repair: ${repaired} / ${entries.length}`);

  if (DRY_RUN) { console.log('[dry-run] no writes.'); return; }
  if (repaired === 0) { console.log('Chain already valid — nothing to repair.'); return; }

  let written = 0;
  for (const u of toUpdate) {
    const { error: upErr } = await sb.from('lisa_decision_log')
      .update({ hash_chain_current: u.hash_chain_current, hash_chain_prev: u.hash_chain_prev })
      .eq('id', u.id);
    if (upErr) { console.error(`update ${u.id} failed:`, upErr.message); }
    else { written++; if (written % 50 === 0) console.log(`  ...${written}/${repaired}`); }
  }
  console.log(`\n✅ Repaired ${written}/${repaired} entries.`);
})();
