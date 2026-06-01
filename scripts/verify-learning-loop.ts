/**
 * Vérification de la boucle d'auto-apprentissage SmartVest.
 *
 * Lance : `pnpm verify:learning-loop` (alias dans package.json racine).
 *
 * Objectif : valider que les 4 fixes du 01/06 (citations enrichies, anti-flap,
 * decay, proposals lifecycle) sont effectifs en prod via 8 métriques clés.
 *
 * Exit code 0 si tout OK, 1 si une métrique en alerte rouge.
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

function loadEnv(): Record<string, string> {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env introuvable à la racine du repo');
    process.exit(2);
  }
  return fs.readFileSync(envPath, 'utf8').split('\n').reduce((acc, l) => {
    const m = l.match(/^([A-Z_]+)=(.+)$/);
    if (m) acc[m[1]] = m[2];
    return acc;
  }, {} as Record<string, string>);
}

const env = loadEnv();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquants dans .env');
  process.exit(2);
}
const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY);

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

type Status = 'OK' | 'WARN' | 'KO' | 'INFO';
const statusBadge: Record<Status, string> = {
  OK: `${colors.green}✅ OK${colors.reset}`,
  WARN: `${colors.yellow}⚠️  WARN${colors.reset}`,
  KO: `${colors.red}❌ KO${colors.reset}`,
  INFO: `${colors.cyan}ℹ️  INFO${colors.reset}`,
};

let anyKo = false;
function print(title: string, status: Status, detail: string) {
  if (status === 'KO') anyKo = true;
  console.log(`${statusBadge[status]}  ${colors.bold}${title}${colors.reset}`);
  console.log(`        ${colors.gray}${detail}${colors.reset}\n`);
}

const TRADER_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';
const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();
const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();

async function check1_CitationResolutionRate(): Promise<void> {
  const { data, error } = await sb
    .from('scanner_lesson_citations')
    .select('id, position_id, outcome_resolved_at, lesson_id')
    .gte('decision_decided_at', since48h);
  if (error) {
    print('1. Citation resolution rate (48h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = data ?? [];
  const total = rows.length;
  const resolved = rows.filter((r) => (r as { outcome_resolved_at?: string }).outcome_resolved_at).length;
  const withPosition = rows.filter((r) => (r as { position_id?: string }).position_id).length;
  const withLesson = rows.filter((r) => (r as { lesson_id?: string }).lesson_id).length;
  const resolvedPct = total > 0 ? Math.round((100 * resolved) / total) : 0;
  const withPosPct = total > 0 ? Math.round((100 * withPosition) / total) : 0;

  let status: Status = 'OK';
  if (total === 0) status = 'INFO';
  else if (resolvedPct < 10) status = 'KO';
  else if (resolvedPct < 30) status = 'WARN';

  print(
    '1. Citation resolution rate (48h)',
    status,
    `total=${total} · resolved=${resolved} (${resolvedPct}%) · with_position=${withPosition} (${withPosPct}%) · with_lesson_id=${withLesson} | target >30%`,
  );
}

async function check2_ProposalsLifecycle(): Promise<void> {
  const { data, error } = await sb
    .from('scanner_proposals')
    .select('status')
    .gte('created_at', since24h);
  if (error) {
    print('2. Proposals lifecycle (24h)', 'INFO', `table absente ou query err: ${error.message.slice(0, 100)} (migration 0185 appliquée?)`);
    return;
  }
  const rows = (data ?? []) as Array<{ status: string }>;
  const total = rows.length;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const accepted = counts.accepted ?? 0;
  const expired = counts.expired ?? 0;
  const pending = counts.pending ?? 0;
  const rejected = counts.rejected ?? 0;
  const acceptPct = total > 0 ? Math.round((100 * accepted) / total) : 0;
  const expiredPct = total > 0 ? Math.round((100 * expired) / total) : 0;

  let status: Status = 'OK';
  if (total === 0) status = 'INFO';
  else if (acceptPct === 0 && total > 10) status = 'KO';
  else if (acceptPct < 5) status = 'WARN';

  print(
    '2. Proposals lifecycle (24h)',
    status,
    `total=${total} · accepted=${accepted} (${acceptPct}%) · expired=${expired} (${expiredPct}%) · pending=${pending} · rejected=${rejected} | acceptPct >5% sain`,
  );
}

async function check3_RiskAdvisoriesEmitted(): Promise<void> {
  const { data, error } = await sb
    .from('lisa_decision_log')
    .select('payload, timestamp')
    .eq('kind', 'risk_advisory')
    .gte('timestamp', since24h);
  if (error) {
    print('3. Risk advisories émis (24h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ payload: { verdict?: string } }>;
  const total = rows.length;
  const byVerdict: Record<string, number> = {};
  for (const r of rows) {
    const v = r.payload?.verdict ?? 'unknown';
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
  }
  const breakdown = Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(', ');

  let status: Status = 'OK';
  if (total === 0) status = 'INFO';

  print(
    '3. Risk advisories émis (24h)',
    status,
    `total=${total} · ${breakdown || '(aucun)'}  | mode advisory actif si non-zéro`,
  );
}

async function check4_LessonAutoApply(): Promise<void> {
  const { data, error } = await sb
    .from('lisa_decision_log')
    .select('kind, payload, timestamp')
    .in('kind', ['lesson_auto_applied', 'lesson_needs_manual_review'])
    .gte('timestamp', since24h);
  if (error) {
    print('4. Lesson auto-apply activity (24h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>;
  const applied = rows.filter((r) => r.kind === 'lesson_auto_applied').length;
  const review = rows.filter((r) => r.kind === 'lesson_needs_manual_review').length;
  // Détection anti-flap : skipped_anti_flap dans payload manual_review
  const antiFlap = rows.filter((r) =>
    r.kind === 'lesson_needs_manual_review' &&
    Array.isArray((r.payload as { skipped_anti_flap?: unknown[] }).skipped_anti_flap)
  ).length;

  let status: Status = 'OK';
  if (applied + review === 0) status = 'INFO';

  print(
    '4. Lesson auto-apply activity (24h)',
    status,
    `applied=${applied} · needs_manual_review=${review} (dont anti-flap=${antiFlap}) | applied >0 sain`,
  );
}

async function check5_LessonsArchived(): Promise<void> {
  const { count: archived } = await sb
    .from('scanner_lessons')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', false)
    .lt('confidence', 0.5);
  const { count: active } = await sb
    .from('scanner_lessons')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  let status: Status = 'INFO';
  if ((active ?? 0) > 10000) status = 'WARN';

  print(
    '5. Lessons stockage (count)',
    status,
    `active=${active ?? '?'} (cap 10k) · archived_by_decay=${archived ?? 0} | decay quotidien 03:00 UTC`,
  );
}

async function check6_TraderActivity(): Promise<void> {
  const { data, error } = await sb
    .from('trader_agent_decisions')
    .select('action_kind, action_applied')
    .eq('portfolio_id', TRADER_PORTFOLIO_ID)
    .gte('decided_at', since24h);
  if (error) {
    print('6. TRADER decisions (24h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ action_kind: string; action_applied: boolean }>;
  const total = rows.length;
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.action_kind] = (byKind[r.action_kind] ?? 0) + 1;
  const applied = rows.filter((r) => r.action_applied).length;
  const opens = byKind.open_directional ?? 0;
  const holds = byKind.hold ?? 0;
  const breakdown = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  let status: Status = 'OK';
  if (total === 0) status = 'KO';
  else if (opens === 0 && total > 30) status = 'WARN';

  print(
    '6. TRADER decisions (24h)',
    status,
    `total=${total} (applied=${applied}) · ${breakdown} | opens=${opens} (TRADER paralysé si 0)`,
  );
}

async function check7_PositionsClosedRecently(): Promise<void> {
  const { data, error } = await sb
    .from('lisa_positions')
    .select('id, realized_pnl_usd, exit_reason, exit_timestamp, portfolio_id')
    .neq('status', 'open')
    .gte('exit_timestamp', since24h);
  if (error) {
    print('7. Positions fermées (24h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ realized_pnl_usd: number; exit_reason: string; portfolio_id: string }>;
  const total = rows.length;
  const sumPnl = rows.reduce((acc, r) => acc + Number(r.realized_pnl_usd ?? 0), 0);
  const wins = rows.filter((r) => Number(r.realized_pnl_usd ?? 0) > 0).length;
  const wr = total > 0 ? Math.round((100 * wins) / total) : 0;
  const traderCount = rows.filter((r) => r.portfolio_id === TRADER_PORTFOLIO_ID).length;
  const byReason: Record<string, number> = {};
  for (const r of rows) byReason[r.exit_reason] = (byReason[r.exit_reason] ?? 0) + 1;
  const topReasons = Object.entries(byReason)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

  let status: Status = 'OK';
  if (total === 0) status = 'INFO';

  print(
    '7. Positions fermées (24h, tous portfolios)',
    status,
    `total=${total} (TRADER=${traderCount}) · WR=${wr}% · Σpnl=$${sumPnl.toFixed(2)} · top exits: ${topReasons || '—'}`,
  );
}

async function check8_RealtimeLessonsCreated(): Promise<void> {
  const { data, error } = await sb
    .from('scanner_lessons')
    .select('id, lesson_kind, lesson_text, created_at')
    .gte('created_at', since24h);
  if (error) {
    print('8. Lessons créées (24h)', 'KO', `query error: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Array<{ lesson_kind: string; lesson_text: string }>;
  const total = rows.length;
  // Vérif dedup : compter les lessons identiques (même lesson_kind + 1res 60 chars text)
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.lesson_kind}|${(r.lesson_text ?? '').slice(0, 60)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupGroups = [...seen.entries()].filter(([, v]) => v >= 3);
  const dupCount = dupGroups.reduce((acc, [, v]) => acc + v, 0);

  let status: Status = 'OK';
  if (dupCount > 0) status = 'WARN';

  const sample = dupGroups.slice(0, 3).map(([k, v]) => `${v}× "${k.slice(0, 60)}"`).join(' | ');

  print(
    '8. Lessons créées (24h)',
    status,
    `total=${total} · doublons potentiels=${dupCount} ${sample ? `→ ${sample}` : ''}`,
  );
}

async function main() {
  console.log(`\n${colors.bold}${colors.cyan}═══ Vérification boucle auto-apprentissage SmartVest ═══${colors.reset}`);
  console.log(`${colors.gray}Fenêtre : 24-48h · TRADER portfolio: ${TRADER_PORTFOLIO_ID.slice(0, 8)}${colors.reset}\n`);

  await check1_CitationResolutionRate();
  await check2_ProposalsLifecycle();
  await check3_RiskAdvisoriesEmitted();
  await check4_LessonAutoApply();
  await check5_LessonsArchived();
  await check6_TraderActivity();
  await check7_PositionsClosedRecently();
  await check8_RealtimeLessonsCreated();

  if (anyKo) {
    console.log(`${colors.bold}${colors.red}⚠️  ÉTAT GLOBAL : au moins une métrique KO — voir détails ci-dessus${colors.reset}\n`);
    process.exit(1);
  }
  console.log(`${colors.bold}${colors.green}✔ Toutes les métriques sont OK ou INFO${colors.reset}\n`);
}

main().catch((e) => {
  console.error(`${colors.red}❌ exception:${colors.reset}`, e);
  process.exit(2);
});
