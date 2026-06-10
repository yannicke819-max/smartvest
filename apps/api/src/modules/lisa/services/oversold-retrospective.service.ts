/**
 * OversoldRetrospectiveService — alimente le corpus de lessons OVERSOLD.
 *
 * Contexte (demande user 10/06/2026) : l'UI a une section Lessons filtrée sur le
 * préfixe de scope `oversold`, mais AUCUN générateur n'écrivait ce scope → la
 * section restait vide. Ce service comble le trou.
 *
 * 100% DÉTERMINISTE (zéro LLM, zéro Gemini — cohérent avec la stratégie oversold) :
 * chaque nuit, pour chaque portefeuille oversold (US/EU), on agrège les décisions
 * de close arrivées à J+10 (contrefactuel finalisé par CloseDecisionCaptureService)
 * et on en dérive 1-2 leçons (timing de sortie + santé), écrites en `scanner_lessons`
 * avec scope `oversold_us_equity` / `oversold_eu_equity` → la section UI se peuple.
 *
 * Matière première : elle n'existe qu'une fois les premières positions oversold
 * arrivées à J+10 (~mi/fin juin pour la 1re cohorte). Avant ça : 0 leçon, sans erreur.
 *
 * Dédup : on n'insère pas la même (scope, lesson_kind) si une leçon active a déjà
 * été créée dans les `dedupDays` derniers jours → refresh hebdomadaire, pas de spam.
 *
 * Gating : OVERSOLD_RETROSPECTIVE_ENABLED (default true — append-only, sans effet
 * sur le trading). Le pipeline oversold ne LIT pas ces lessons ; elles servent à
 * l'inspection humaine (et à un futur tuning manuel du hold/lock).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../supabase/supabase.service';
import { buildOversoldLessons, type OversoldCloseRow } from './oversold-retrospective.helper';

interface OversoldPortfolioTarget {
  portfolioId: string;
  region: string; // libellé humain pour le texte ('US' / 'EU')
  scope: string; // 'oversold_us_equity' | 'oversold_eu_equity'
}

// Portefeuilles oversold connus (cf. CLAUDE.md — US a0000001, EU a0000003).
const OVERSOLD_TARGETS: OversoldPortfolioTarget[] = [
  { portfolioId: 'a0000001-0000-0000-0000-000000000001', region: 'US', scope: 'oversold_us_equity' },
  { portfolioId: 'a0000003-0000-0000-0000-000000000003', region: 'EU', scope: 'oversold_eu_equity' },
];

@Injectable()
export class OversoldRetrospectiveService {
  private readonly logger = new Logger(OversoldRetrospectiveService.name);
  private enabled = true;
  private minSample = 5;
  private lookbackDays = 60;
  private readonly dedupDays = 6;

  constructor(
    private readonly config: ConfigService,
    private readonly supabase: SupabaseService,
  ) {}

  onModuleInit(): void {
    this.enabled = (this.config.get<string>('OVERSOLD_RETROSPECTIVE_ENABLED') ?? 'true').toLowerCase() === 'true';
    const ms = Number(this.config.get<string>('OVERSOLD_RETRO_MIN_SAMPLE'));
    if (Number.isFinite(ms) && ms >= 1) this.minSample = Math.floor(ms);
    const lb = Number(this.config.get<string>('OVERSOLD_RETRO_LOOKBACK_DAYS'));
    if (Number.isFinite(lb) && lb >= 7) this.lookbackDays = Math.floor(lb);
  }

  /** Cron quotidien 22:45 UTC — juste après le trajectory-labeler (22:30). */
  @Cron('0 45 22 * * *', { name: 'oversold-retrospective', timeZone: 'UTC' })
  async runRetrospective(): Promise<void> {
    if (!this.enabled || !this.supabase.isReady()) return;
    let inserted = 0;
    for (const t of OVERSOLD_TARGETS) {
      try {
        inserted += await this.runForTarget(t);
      } catch (e) {
        this.logger.warn(`[oversold-retro] ${t.region}: ${String(e).slice(0, 150)}`);
      }
    }
    if (inserted > 0) this.logger.log(`[oversold-retro] ${inserted} leçon(s) oversold écrite(s)`);
  }

  private async runForTarget(t: OversoldPortfolioTarget): Promise<number> {
    const client = this.supabase.getClient();
    const since = new Date(Date.now() - this.lookbackDays * 24 * 3600_000).toISOString();
    // Closes FINALISÉS (J+10 atteint → deadline_verdict posé) sur la fenêtre.
    const { data, error } = await client
      .from('position_close_decisions')
      .select('pnl_pct, pnl_usd, deadline_verdict, pnl_if_held_to_deadline_pct, best_day_label, best_day_pnl_pct')
      .eq('portfolio_id', t.portfolioId)
      .not('deadline_verdict', 'is', null)
      .gte('closed_at', since)
      .limit(1000);
    if (error) {
      this.logger.warn(`[oversold-retro] ${t.region} read: ${error.message}`);
      return 0;
    }
    const rows: OversoldCloseRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
      pnlPct: r.pnl_pct == null ? null : Number(r.pnl_pct),
      pnlUsd: r.pnl_usd == null ? null : Number(r.pnl_usd),
      deadlineVerdict: (r.deadline_verdict as string | null) ?? null,
      pnlIfHeldToDeadlinePct: r.pnl_if_held_to_deadline_pct == null ? null : Number(r.pnl_if_held_to_deadline_pct),
      bestDayLabel: (r.best_day_label as string | null) ?? null,
      bestDayPnlPct: r.best_day_pnl_pct == null ? null : Number(r.best_day_pnl_pct),
    }));

    const candidates = buildOversoldLessons(rows, { region: t.region, scope: t.scope, minSample: this.minSample });
    if (candidates.length === 0) return 0;

    const today = new Date().toISOString().slice(0, 10);
    let inserted = 0;
    for (const c of candidates) {
      // Dédup : skip si une leçon active de même (scope, lesson_kind) existe déjà
      // dans les `dedupDays` derniers jours (refresh hebdo, pas quotidien).
      const dedupSince = new Date(Date.now() - this.dedupDays * 24 * 3600_000).toISOString();
      const { data: existing } = await client
        .from('scanner_lessons')
        .select('id')
        .eq('scope', c.scope)
        .eq('lesson_kind', c.lessonKind)
        .eq('is_active', true)
        .gte('created_at', dedupSince)
        .limit(1);
      if (existing && existing.length > 0) continue;

      const { error: insErr } = await client.from('scanner_lessons').insert({
        derived_from_date: today,
        lesson_kind: c.lessonKind,
        lesson_text: c.lessonText,
        macro_condition: null,
        scope: c.scope,
        confidence: c.confidence,
        sample_size: c.sampleSize,
        win_rate_observed: c.winRateObserved != null ? Math.round(c.winRateObserved * 100) / 100 : null,
        avg_pnl_usd: c.avgPnlUsd != null ? Math.round(c.avgPnlUsd * 100) / 100 : null,
        is_active: true,
        applied: false,
        payload: c.payload,
      });
      if (insErr) {
        this.logger.warn(`[oversold-retro] ${t.region} insert ${c.lessonKind}: ${insErr.message}`);
        continue;
      }
      inserted++;
    }
    return inserted;
  }
}
