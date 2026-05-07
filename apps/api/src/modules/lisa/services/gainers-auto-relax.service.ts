import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../../supabase/supabase.service';
import { GainersUserShadowService, type RegretGateRow } from './gainers-user-shadow.service';

/**
 * GainersAutoRelaxService — PR #282 (Phase 3, étape 2).
 *
 * Lit `cumulative_regret_usd` et `n_rejections` 7j glissants par gate
 * (via GainersUserShadowService.getRegretSummary), décide si un gate est
 * trop strict, et propose / auto-applique un relax d'1 step.
 *
 * Spec utilisateur :
 *   - ROLLING 7j cumulé > $150 ET n_rejections_7d ≥ 30 (volume + magnitude)
 *   - Verdict GATE_TOO_STRICT requis (CI lower > 0)
 *   - NON auto-tightening (tighten reste manuel)
 *   - HYBRIDE : propose default, auto conditionné
 *   - Floor protection par gate (ne descend jamais en dessous)
 *   - Cooldown 7j par gate après application (laisse le marché révéler)
 *
 * Step kinds par gate :
 *   - reject_path_eff       → -0.05 sur gainers_min_path_efficiency, floor 0.20
 *   - reject_persistence    → -0.05 sur gainers_min_persistence_score, floor 0.40
 *   - reject_cooldown       → ÷2 sur gainers_cooldown_minutes, floor 1
 *   - reject_post_sl_cooldown → ÷2 sur gainers_post_sl_cooldown_min, floor 15
 *   - reject_no_tf_data     → no relax (data quality issue, pas un config issue)
 *
 * Cf. CLAUDE.md (P9 adaptive selectivity) + PR #280 spec.
 */

const REGRET_THRESHOLD_USD = 150;
const MIN_REJECTIONS_7D = 30;
const COOLDOWN_DAYS_AFTER_APPLY = 7;
const RELEVANT_GRID = 'baseline_60m';

interface RelaxRule {
  gate: string;
  configColumn: string;
  stepKind: 'subtract_0_05' | 'divide_2';
  floor: number;
}

const RELAX_RULES: Record<string, RelaxRule> = {
  reject_path_eff: {
    gate: 'reject_path_eff',
    configColumn: 'gainers_min_path_efficiency',
    stepKind: 'subtract_0_05',
    floor: 0.20,
  },
  reject_persistence: {
    gate: 'reject_persistence',
    configColumn: 'gainers_min_persistence_score',
    stepKind: 'subtract_0_05',
    floor: 0.40,
  },
  reject_cooldown: {
    gate: 'reject_cooldown',
    configColumn: 'gainers_cooldown_minutes',
    stepKind: 'divide_2',
    floor: 1,
  },
  reject_post_sl_cooldown: {
    gate: 'reject_post_sl_cooldown',
    configColumn: 'gainers_post_sl_cooldown_min',
    stepKind: 'divide_2',
    floor: 15,
  },
};

export interface ProposalCreated {
  gate: string;
  oldValue: number;
  newValue: number;
  cumulativeRegretUsd: number;
  nRejections7d: number;
  mode: 'propose' | 'auto';
  applied: boolean;
}

/**
 * Pure helper : applique un step de relax avec floor protection.
 * Return null si déjà au floor (pas de relax possible).
 */
export function computeRelaxStep(
  rule: RelaxRule,
  currentValue: number | null | undefined,
): { newValue: number } | null {
  if (currentValue == null || !Number.isFinite(currentValue)) return null;
  let next: number;
  if (rule.stepKind === 'subtract_0_05') {
    next = Math.max(rule.floor, currentValue - 0.05);
  } else if (rule.stepKind === 'divide_2') {
    next = Math.max(rule.floor, Math.floor(currentValue / 2));
  } else {
    return null;
  }
  // Si déjà au floor (ou en dessous par config user), rien à faire
  if (next >= currentValue) return null;
  return { newValue: next };
}

/**
 * Pure helper : décide si une row regret-summary justifie un relax.
 * Critères (rolling 7j) :
 *   1. verdict === 'GATE_TOO_STRICT' (CI lower > 0)
 *   2. cumulative_regret_usd > $150
 *   3. n >= 30 (anti-luck)
 *   4. gate dans RELAX_RULES (data quality gate exclu)
 */
export function shouldRelax(row: RegretGateRow): boolean {
  if (row.grid !== RELEVANT_GRID) return false;
  if (row.verdict !== 'GATE_TOO_STRICT') return false;
  if (row.cumulative_regret_usd <= REGRET_THRESHOLD_USD) return false;
  if (row.n < MIN_REJECTIONS_7D) return false;
  if (!RELAX_RULES[row.decision]) return false;
  return true;
}

@Injectable()
export class GainersAutoRelaxService {
  private readonly logger = new Logger(GainersAutoRelaxService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly userShadow: GainersUserShadowService,
  ) {}

  /**
   * Cron 30 min UTC. Parcourt les portfolios avec adaptive_mode != 'off'.
   * Pourquoi 30 min (et non 5 min comme adaptive trajectory) : la fenêtre 7j
   * ne change pas significativement en 5 min, et on évite la pression inutile
   * sur la table gainers_user_shadow_signals.
   */
  @Cron('*/30 * * * *', { timeZone: 'UTC' })
  async runCron(): Promise<void> {
    try {
      const { data: portfolios } = await this.supabase.getClient()
        .from('lisa_session_configs')
        .select('portfolio_id, adaptive_mode')
        .neq('adaptive_mode', 'off');
      if (!portfolios || portfolios.length === 0) {
        this.logger.debug('[auto-relax] no portfolio with adaptive_mode != off');
        return;
      }
      for (const row of portfolios) {
        const mode = String(row.adaptive_mode);
        if (mode !== 'propose' && mode !== 'auto') continue;
        try {
          await this.runForPortfolio(String(row.portfolio_id), mode);
        } catch (e) {
          this.logger.warn(`[auto-relax] portfolio ${String(row.portfolio_id).slice(0, 8)}: ${String(e).slice(0, 100)}`);
        }
      }
    } catch (e) {
      this.logger.error(`[auto-relax] cron failed: ${String(e).slice(0, 200)}`);
    }
  }

  /**
   * Run pour un portfolio : lit summary regret 7j, identifie les gates trop
   * stricts, applique propose/auto selon mode courant, respecte cooldown 7j.
   */
  async runForPortfolio(portfolioId: string, mode: 'propose' | 'auto'): Promise<{
    candidates: number;
    proposals: ProposalCreated[];
  }> {
    const summary = await this.userShadow.getRegretSummary(portfolioId, 7);
    const candidates = summary.byGate.filter(shouldRelax);
    if (candidates.length === 0) {
      return { candidates: 0, proposals: [] };
    }

    // Charge la config courante pour lire les valeurs actuelles
    const { data: cfg } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .select(
        'gainers_min_path_efficiency, gainers_min_persistence_score, ' +
        'gainers_cooldown_minutes, gainers_post_sl_cooldown_min',
      )
      .eq('portfolio_id', portfolioId)
      .maybeSingle();

    if (!cfg) {
      this.logger.warn(`[auto-relax] portfolio ${portfolioId.slice(0, 8)}: no session_config row`);
      return { candidates: candidates.length, proposals: [] };
    }

    // Charge les dernières applications par gate pour cooldown 7j
    const cooldownThreshold = new Date(Date.now() - COOLDOWN_DAYS_AFTER_APPLY * 86400_000).toISOString();
    const { data: recent } = await this.supabase.getClient()
      .from('gainers_adaptive_proposals')
      .select('gate, applied_at')
      .eq('portfolio_id', portfolioId)
      .eq('applied', true)
      .gte('applied_at', cooldownThreshold);
    const onCooldown = new Set<string>(
      (recent ?? [])
        .map((r) => String(r.gate))
        .filter((g) => Boolean(g)),
    );

    const created: ProposalCreated[] = [];
    for (const cand of candidates) {
      const rule = RELAX_RULES[cand.decision];
      if (!rule) continue;
      if (onCooldown.has(rule.gate)) {
        this.logger.debug(`[auto-relax] ${portfolioId.slice(0, 8)}: ${rule.gate} on cooldown 7j → skip`);
        continue;
      }
      const currentValue = (cfg as unknown as Record<string, unknown>)[rule.configColumn];
      const step = computeRelaxStep(rule, Number(currentValue));
      if (!step) continue;

      // Insert proposal row (propose) — INSERT atomique avant l'éventuel UPDATE
      // de la config DB (mode auto). En cas de crash entre les deux, l'audit
      // existe → le user voit la trace même si le UPDATE n'a pas eu lieu.
      const { data: proposalRow, error: insertErr } = await this.supabase.getClient()
        .from('gainers_adaptive_proposals')
        .insert({
          portfolio_id: portfolioId,
          gate: rule.gate,
          config_column: rule.configColumn,
          old_value: Number(currentValue),
          new_value: step.newValue,
          step_kind: rule.stepKind,
          cumulative_regret_usd: cand.cumulative_regret_usd,
          n_rejections_7d: cand.n,
          mean_pnl_pct: cand.mean_pnl_pct,
          ci_low: cand.ci_low,
          ci_high: cand.ci_high,
          verdict: cand.verdict,
          mode,
          applied: false,
        })
        .select('id')
        .single();
      if (insertErr || !proposalRow) {
        this.logger.warn(`[auto-relax] insert proposal failed for ${rule.gate}: ${insertErr?.message ?? 'unknown'}`);
        continue;
      }

      let applied = false;
      if (mode === 'auto') {
        // Auto-apply : UPDATE config + flag proposal applied=true
        const update: Record<string, unknown> = {};
        update[rule.configColumn] = step.newValue;
        const { error: updErr } = await this.supabase.getClient()
          .from('lisa_session_configs')
          .update(update)
          .eq('portfolio_id', portfolioId);
        if (updErr) {
          this.logger.warn(`[auto-relax] auto-apply UPDATE failed for ${rule.gate}: ${updErr.message}`);
        } else {
          applied = true;
          await this.supabase.getClient()
            .from('gainers_adaptive_proposals')
            .update({
              applied: true,
              applied_at: new Date().toISOString(),
              applied_by: 'auto_cron',
            })
            .eq('id', proposalRow.id);
          this.logger.log(
            `[auto-relax] AUTO-APPLIED ${portfolioId.slice(0, 8)}: ${rule.configColumn} ` +
            `${currentValue} → ${step.newValue} (regret_7d=$${cand.cumulative_regret_usd.toFixed(0)}, n=${cand.n})`,
          );
        }
      } else {
        this.logger.log(
          `[auto-relax] PROPOSED ${portfolioId.slice(0, 8)}: ${rule.configColumn} ` +
          `${currentValue} → ${step.newValue} (regret_7d=$${cand.cumulative_regret_usd.toFixed(0)}, n=${cand.n}) — pending user approval`,
        );
      }

      created.push({
        gate: rule.gate,
        oldValue: Number(currentValue),
        newValue: step.newValue,
        cumulativeRegretUsd: cand.cumulative_regret_usd,
        nRejections7d: cand.n,
        mode,
        applied,
      });
    }

    return { candidates: candidates.length, proposals: created };
  }

  /**
   * List pending proposals (mode='propose', applied=false) pour UI.
   */
  async listPendingProposals(portfolioId: string, limit: number = 50): Promise<unknown[]> {
    const { data } = await this.supabase.getClient()
      .from('gainers_adaptive_proposals')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('applied', false)
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }

  /**
   * Apply manually a pending proposal. UI call after user click "Appliquer".
   * Marque applied=true + UPDATE config DB.
   */
  async applyProposal(proposalId: string, applyByEmail: string): Promise<{ ok: boolean; reason?: string }> {
    const { data: proposal, error } = await this.supabase.getClient()
      .from('gainers_adaptive_proposals')
      .select('*')
      .eq('id', proposalId)
      .single();
    if (error || !proposal) {
      return { ok: false, reason: 'proposal_not_found' };
    }
    if (proposal.applied) {
      return { ok: false, reason: 'already_applied' };
    }
    const update: Record<string, unknown> = {};
    update[String(proposal.config_column)] = Number(proposal.new_value);
    const { error: updErr } = await this.supabase.getClient()
      .from('lisa_session_configs')
      .update(update)
      .eq('portfolio_id', proposal.portfolio_id);
    if (updErr) {
      return { ok: false, reason: `update_failed: ${updErr.message}` };
    }
    await this.supabase.getClient()
      .from('gainers_adaptive_proposals')
      .update({
        applied: true,
        applied_at: new Date().toISOString(),
        applied_by: applyByEmail,
      })
      .eq('id', proposalId);
    return { ok: true };
  }
}
