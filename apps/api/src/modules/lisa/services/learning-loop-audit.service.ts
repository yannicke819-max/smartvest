/**
 * LearningLoopAuditService — service NestJS qui audit la boucle d'auto-apprentissage.
 *
 * Porte la logique du script CLI `scripts/verify-learning-loop.ts` en backend
 * pour exposer un endpoint admin `/admin/verify-learning-loop` invocable depuis
 * l'UI (bouton "Re-lancer audit" dans /lisa).
 *
 * Read-only : aucune écriture DB, juste 8 SELECT agrégés.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';

const TRADER_PORTFOLIO_ID = 'b0000001-0000-0000-0000-000000000001';

export type CheckStatus = 'OK' | 'WARN' | 'KO' | 'INFO';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface AuditReport {
  generated_at: string;
  trader_portfolio_id: string;
  global_status: CheckStatus;
  checks: CheckResult[];
}

@Injectable()
export class LearningLoopAuditService {
  private readonly logger = new Logger(LearningLoopAuditService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async runAudit(): Promise<AuditReport> {
    const checks: CheckResult[] = [];
    const since48h = new Date(Date.now() - 48 * 3600_000).toISOString();
    const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
    const since1h = new Date(Date.now() - 3600_000).toISOString();

    checks.push(await this.checkCitationResolution(since48h));
    checks.push(await this.checkProposalsLifecycle(since24h));
    checks.push(await this.checkRiskAdvisories(since24h));
    checks.push(await this.checkLessonAutoApply(since24h));
    checks.push(await this.checkLessonsStorage());
    checks.push(await this.checkTraderActivity(since24h));
    checks.push(await this.checkClosedPositions(since24h));
    checks.push(await this.checkLessonsCreated(since24h, since1h));

    // Global status = pire des checks
    const order: CheckStatus[] = ['KO', 'WARN', 'INFO', 'OK'];
    let global: CheckStatus = 'OK';
    for (const c of checks) {
      if (order.indexOf(c.status) < order.indexOf(global)) global = c.status;
    }

    return {
      generated_at: new Date().toISOString(),
      trader_portfolio_id: TRADER_PORTFOLIO_ID,
      global_status: global,
      checks,
    };
  }

  private async checkCitationResolution(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('scanner_lesson_citations')
        .select('id, position_id, outcome_resolved_at, lesson_id')
        .gte('decision_decided_at', since);
      if (error) return this.ko('citations_resolution', 'Citation resolution rate (48h)', `query error: ${error.message}`);
      const rows = data ?? [];
      const total = rows.length;
      const resolved = rows.filter((r) => (r as { outcome_resolved_at?: string }).outcome_resolved_at).length;
      const withPos = rows.filter((r) => (r as { position_id?: string }).position_id).length;
      const withLesson = rows.filter((r) => (r as { lesson_id?: string }).lesson_id).length;
      const resolvedPct = total > 0 ? Math.round((100 * resolved) / total) : 0;
      const withPosPct = total > 0 ? Math.round((100 * withPos) / total) : 0;
      let status: CheckStatus = 'OK';
      if (total === 0) status = 'INFO';
      else if (resolvedPct < 10) status = 'KO';
      else if (resolvedPct < 30) status = 'WARN';
      return {
        id: 'citations_resolution',
        title: 'Citation resolution rate (48h)',
        status,
        detail: `total=${total} · resolved=${resolved} (${resolvedPct}%) · with_position=${withPos} (${withPosPct}%) · with_lesson_id=${withLesson}`,
        data: { total, resolved, resolved_pct: resolvedPct, with_position: withPos, with_lesson_id: withLesson, target: '>30%' },
      };
    } catch (e) {
      return this.ko('citations_resolution', 'Citation resolution rate (48h)', String(e).slice(0, 100));
    }
  }

  private async checkProposalsLifecycle(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb.from('scanner_proposals').select('status').gte('created_at', since);
      if (error) return this.info('proposals_lifecycle', 'Proposals lifecycle (24h)', `table absente ou err: ${error.message.slice(0, 100)} — migration 0185 appliquée?`);
      const rows = (data ?? []) as Array<{ status: string }>;
      const total = rows.length;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const accepted = counts.accepted ?? 0;
      const expired = counts.expired ?? 0;
      const pending = counts.pending ?? 0;
      const rejected = counts.rejected ?? 0;
      const acceptPct = total > 0 ? Math.round((100 * accepted) / total) : 0;
      let status: CheckStatus = 'OK';
      if (total === 0) status = 'INFO';
      else if (acceptPct === 0 && total > 10) status = 'KO';
      else if (acceptPct < 5) status = 'WARN';
      return {
        id: 'proposals_lifecycle',
        title: 'Proposals lifecycle (24h)',
        status,
        detail: `total=${total} · accepted=${accepted} (${acceptPct}%) · expired=${expired} · pending=${pending} · rejected=${rejected}`,
        data: { total, accepted, expired, pending, rejected, accept_pct: acceptPct, target: '>5% sain' },
      };
    } catch (e) {
      return this.ko('proposals_lifecycle', 'Proposals lifecycle (24h)', String(e).slice(0, 100));
    }
  }

  private async checkRiskAdvisories(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('lisa_decision_log')
        .select('payload, timestamp')
        .eq('kind', 'risk_advisory')
        .gte('timestamp', since);
      if (error) return this.ko('risk_advisories', 'Risk advisories émis (24h)', `query error: ${error.message}`);
      const rows = (data ?? []) as Array<{ payload: { verdict?: string } }>;
      const total = rows.length;
      const byVerdict: Record<string, number> = {};
      for (const r of rows) {
        const v = r.payload?.verdict ?? 'unknown';
        byVerdict[v] = (byVerdict[v] ?? 0) + 1;
      }
      const breakdown = Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(', ') || '(aucun)';
      return {
        id: 'risk_advisories',
        title: 'Risk advisories émis (24h)',
        status: total === 0 ? 'INFO' : 'OK',
        detail: `total=${total} · ${breakdown}`,
        data: { total, by_verdict: byVerdict, target: 'non-zéro = mode advisory actif' },
      };
    } catch (e) {
      return this.ko('risk_advisories', 'Risk advisories émis (24h)', String(e).slice(0, 100));
    }
  }

  private async checkLessonAutoApply(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('lisa_decision_log')
        .select('kind, payload, timestamp')
        .in('kind', ['lesson_auto_applied', 'lesson_needs_manual_review'])
        .gte('timestamp', since);
      if (error) return this.ko('lesson_auto_apply', 'Lesson auto-apply activity (24h)', `query error: ${error.message}`);
      const rows = (data ?? []) as Array<{ kind: string; payload: Record<string, unknown> }>;
      const applied = rows.filter((r) => r.kind === 'lesson_auto_applied').length;
      const review = rows.filter((r) => r.kind === 'lesson_needs_manual_review').length;
      const antiFlap = rows.filter((r) =>
        r.kind === 'lesson_needs_manual_review' &&
        Array.isArray((r.payload as { skipped_anti_flap?: unknown[] }).skipped_anti_flap)
      ).length;
      return {
        id: 'lesson_auto_apply',
        title: 'Lesson auto-apply activity (24h)',
        status: applied + review === 0 ? 'INFO' : 'OK',
        detail: `applied=${applied} · needs_manual_review=${review} (dont anti-flap=${antiFlap})`,
        data: { applied, needs_review: review, anti_flap: antiFlap, target: 'applied >0' },
      };
    } catch (e) {
      return this.ko('lesson_auto_apply', 'Lesson auto-apply activity (24h)', String(e).slice(0, 100));
    }
  }

  private async checkLessonsStorage(): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { count: archived } = await sb
        .from('scanner_lessons')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', false)
        .lt('confidence', 0.5);
      const { count: active } = await sb
        .from('scanner_lessons')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);
      let status: CheckStatus = 'INFO';
      if ((active ?? 0) > 10000) status = 'WARN';
      return {
        id: 'lessons_storage',
        title: 'Lessons stockage (count)',
        status,
        detail: `active=${active ?? '?'} (cap 10k) · archived_by_decay=${archived ?? 0}`,
        data: { active, archived_by_decay: archived, target: 'active <10k, decay quotidien 03:00 UTC' },
      };
    } catch (e) {
      return this.ko('lessons_storage', 'Lessons stockage', String(e).slice(0, 100));
    }
  }

  private async checkTraderActivity(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('trader_agent_decisions')
        .select('action_kind, action_applied, input_state')
        .eq('portfolio_id', TRADER_PORTFOLIO_ID)
        .gte('decided_at', since);
      if (error) return this.ko('trader_activity', 'TRADER decisions (24h)', `query error: ${error.message}`);
      const rows = (data ?? []) as Array<{ action_kind: string; action_applied: boolean; input_state?: Record<string, unknown> }>;
      const total = rows.length;
      const byKind: Record<string, number> = {};
      for (const r of rows) byKind[r.action_kind] = (byKind[r.action_kind] ?? 0) + 1;
      const applied = rows.filter((r) => r.action_applied).length;
      const opens = byKind.open_directional ?? 0;
      // Vérif que le state contient les 3 nouveaux champs (preuve commit 42cf74c effectif)
      const latest = rows.length > 0 ? rows[rows.length - 1] : null;
      const stateKeys = Object.keys(latest?.input_state ?? {});
      const hasObjectives = stateKeys.includes('objectives_progress');
      const hasProposals = stateKeys.includes('scanner_proposals');
      const hasAdvisories = stateKeys.includes('risk_advisories');
      let status: CheckStatus = 'OK';
      if (total === 0) status = 'KO';
      else if (opens === 0 && total > 30) status = 'WARN';
      if (!hasObjectives || !hasProposals || !hasAdvisories) status = 'WARN'; // deploy pas effectif
      return {
        id: 'trader_activity',
        title: 'TRADER decisions (24h)',
        status,
        detail: `total=${total} · applied=${applied} · opens=${opens} · state[obj=${hasObjectives ? '✓' : '✗'} prop=${hasProposals ? '✓' : '✗'} adv=${hasAdvisories ? '✓' : '✗'}]`,
        data: { total, applied, opens, by_kind: byKind, state_has_objectives: hasObjectives, state_has_proposals: hasProposals, state_has_advisories: hasAdvisories },
      };
    } catch (e) {
      return this.ko('trader_activity', 'TRADER decisions (24h)', String(e).slice(0, 100));
    }
  }

  private async checkClosedPositions(since: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('lisa_positions')
        .select('realized_pnl_usd, exit_reason, portfolio_id')
        .neq('status', 'open')
        .gte('exit_timestamp', since);
      if (error) return this.ko('closed_positions', 'Positions fermées (24h)', `query error: ${error.message}`);
      const rows = (data ?? []) as Array<{ realized_pnl_usd: number; exit_reason: string; portfolio_id: string }>;
      const total = rows.length;
      const sumPnl = rows.reduce((acc, r) => acc + Number(r.realized_pnl_usd ?? 0), 0);
      const wins = rows.filter((r) => Number(r.realized_pnl_usd ?? 0) > 0).length;
      const wr = total > 0 ? Math.round((100 * wins) / total) : 0;
      const traderCount = rows.filter((r) => r.portfolio_id === TRADER_PORTFOLIO_ID).length;
      const byReason: Record<string, number> = {};
      for (const r of rows) {
        const key = r.exit_reason?.slice(0, 50) ?? 'unknown';
        byReason[key] = (byReason[key] ?? 0) + 1;
      }
      const topReasons = Object.entries(byReason)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || '—';
      return {
        id: 'closed_positions',
        title: 'Positions fermées (24h, tous portfolios)',
        status: total === 0 ? 'INFO' : 'OK',
        detail: `total=${total} (TRADER=${traderCount}) · WR=${wr}% · Σpnl=$${sumPnl.toFixed(2)} · top exits: ${topReasons}`,
        data: { total, trader_count: traderCount, sum_pnl_usd: sumPnl, wins, win_rate_pct: wr, top_reasons: byReason },
      };
    } catch (e) {
      return this.ko('closed_positions', 'Positions fermées', String(e).slice(0, 100));
    }
  }

  private async checkLessonsCreated(since24h: string, since1h: string): Promise<CheckResult> {
    try {
      const sb = this.supabase.getClient();
      const { data, error } = await sb
        .from('scanner_lessons')
        .select('lesson_kind, lesson_text, created_at')
        .gte('created_at', since24h);
      if (error) return this.ko('lessons_created', 'Lessons créées (24h)', `query error: ${error.message}`);
      const rows = (data ?? []) as Array<{ lesson_kind: string; lesson_text: string; created_at: string }>;
      const total = rows.length;
      const seen = new Map<string, number>();
      for (const r of rows) {
        const key = `${r.lesson_kind}|${(r.lesson_text ?? '').slice(0, 60)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      const dupKeys = new Set([...seen.entries()].filter(([, v]) => v >= 3).map(([k]) => k));
      const dupCount = rows.filter((r) => dupKeys.has(`${r.lesson_kind}|${(r.lesson_text ?? '').slice(0, 60)}`)).length;
      const dupLast1h = rows.filter((r) => r.created_at >= since1h
        && dupKeys.has(`${r.lesson_kind}|${(r.lesson_text ?? '').slice(0, 60)}`)).length;
      // Tag dedup detection
      const withIdTag = rows.filter((r) => /\[ID:[A-Z][A-Z0-9_.+-]+_/i.test(r.lesson_text ?? '')).length;
      let status: CheckStatus = 'OK';
      if (dupLast1h > 0) status = 'WARN';
      return {
        id: 'lessons_created',
        title: 'Lessons créées (24h)',
        status,
        detail: `total=${total} · doublons globaux=${dupCount} · doublons 1h=${dupLast1h} · with [ID:] tag=${withIdTag}`,
        data: { total, dup_global: dupCount, dup_last_hour: dupLast1h, with_id_tag: withIdTag, target: 'dup_last_hour=0 sain' },
      };
    } catch (e) {
      return this.ko('lessons_created', 'Lessons créées', String(e).slice(0, 100));
    }
  }

  private ko(id: string, title: string, detail: string): CheckResult {
    return { id, title, status: 'KO', detail };
  }
  private info(id: string, title: string, detail: string): CheckResult {
    return { id, title, status: 'INFO', detail };
  }
}
