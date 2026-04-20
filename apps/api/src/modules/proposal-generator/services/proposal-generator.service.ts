import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { ProposalScorerService } from './proposal-scorer.service';
import { FrictionEstimatorService } from './friction-estimator.service';
import { DriftSource } from './sources/drift.source';
import { ConcentrationSource } from './sources/concentration.source';
import { GoalTriggerSource } from './sources/goal-trigger.source';
import { MacroSignalSource } from './sources/macro-signal.source';
import { PerformanceSource } from './sources/performance.source';
import type { RawProposal, GenerationResult } from '../interfaces/raw-proposal';

/** Maximum proposals created per generation run (prevents flooding the review centre) */
const MAX_PROPOSALS_PER_RUN = 5;

type MandateRow = Record<string, unknown>;

@Injectable()
export class ProposalGeneratorService {
  private readonly logger = new Logger(ProposalGeneratorService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly flags: FeatureFlagsService,
    private readonly scorer: ProposalScorerService,
    private readonly friction: FrictionEstimatorService,
    private readonly drift: DriftSource,
    private readonly concentration: ConcentrationSource,
    private readonly goalTrigger: GoalTriggerSource,
    private readonly macroSignal: MacroSignalSource,
    private readonly performance: PerformanceSource,
  ) {}

  async generateForPortfolio(portfolioId: string, userId: string): Promise<GenerationResult> {
    // 1. Feature-flag gate
    if (!this.flags.isEnabled('DELEGATION_HYBRID_SUGGESTIVE')) {
      return { generated: 0, skipped: 0, blocked: 0, reason: 'flag_disabled', proposalIds: [] };
    }

    // 2. Active mandate (optional — MANUAL_EXPLICIT works without one)
    const mandate = await this.getActiveMandate(portfolioId);

    if (mandate?.['kill_switch_active']) {
      return { generated: 0, skipped: 0, blocked: 0, reason: 'kill_switch_active', proposalIds: [] };
    }

    // 3. Run all sources in parallel — failures are isolated, never crash the generator
    const sourceResults = await Promise.allSettled([
      this.drift.detect(portfolioId, userId),
      this.concentration.detect(portfolioId, userId, mandate as any),
      this.goalTrigger.detect(portfolioId, userId),
      this.macroSignal.detect(portfolioId, userId),
      this.performance.detect(portfolioId, userId, mandate as any),
    ]);

    const all: RawProposal[] = [];
    for (const result of sourceResults) {
      if (result.status === 'fulfilled') {
        all.push(...result.value);
      } else {
        this.logger.warn(`Source failed: ${result.reason}`);
      }
    }

    // 4. Guardrail filter
    const { allowed, blocked } = this.scorer.applyGuardrails(all, mandate ? {
      kill_switch_active: Boolean(mandate['kill_switch_active']),
      status: mandate['status'] as string,
      forbidden_tickers: (mandate['forbidden_tickers'] as string[]) ?? [],
      allowed_asset_classes: (mandate['allowed_asset_classes'] as string[]) ?? [],
    } : null);

    // Write guardrail_blocked audit events for each blocked proposal
    for (const { proposal, reason } of blocked) {
      await this.writeAuditEvent(portfolioId, userId, mandate?.['id'] as string | undefined, null, 'guardrail_blocked', reason, proposal);
    }

    // 5. Deduplicate against existing DB proposals (within dedup windows)
    const fresh: RawProposal[] = [];
    for (const p of this.scorer.rankAndDedup(allowed)) {
      const dup = await this.isDuplicate(portfolioId, p);
      if (!dup) fresh.push(p);
    }

    // 6. Cap at MAX_PROPOSALS_PER_RUN (already sorted by score)
    const toCreate = fresh.slice(0, MAX_PROPOSALS_PER_RUN);
    const skipped = fresh.length - toCreate.length + (allowed.length - fresh.length);

    // 7. Persist proposals
    const proposalIds: string[] = [];
    for (const raw of toCreate) {
      const id = await this.persistProposal(portfolioId, userId, mandate?.['id'] as string | undefined, raw);
      proposalIds.push(id);
    }

    this.logger.log(`Portfolio ${portfolioId}: +${proposalIds.length} proposals, ${skipped} skipped, ${blocked.length} blocked by guardrails`);

    return {
      generated: proposalIds.length,
      skipped,
      blocked: blocked.length,
      proposalIds,
    };
  }

  private async getActiveMandate(portfolioId: string): Promise<MandateRow | null> {
    const { data } = await this.supabase.getClient()
      .from('autonomy_mandates')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .eq('status', 'active')
      .maybeSingle();
    return (data as MandateRow | null) ?? null;
  }

  private async isDuplicate(portfolioId: string, proposal: RawProposal): Promise<boolean> {
    const windowDays = this.scorer.dedupWindowDays(proposal.sourceKind);
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    let q = this.supabase.getClient()
      .from('action_proposals')
      .select('id', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('action', proposal.action)
      .in('lifecycle_state', ['presented', 'draft'])
      .gte('created_at', cutoff);
    if (proposal.ticker) q = q.eq('ticker', proposal.ticker);
    const { count } = await q;
    return (count ?? 0) > 0;
  }

  private async persistProposal(
    portfolioId: string,
    userId: string,
    mandateId: string | undefined,
    raw: RawProposal,
  ): Promise<string> {
    const proposalId = uuid();
    const expiresAt = new Date(Date.now() + raw.expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const frictionEst = raw.notional
      ? this.friction.estimate(raw.notional, raw.currency !== 'EUR')
      : null;

    await this.supabase.getClient().from('action_proposals').insert({
      id: proposalId,
      portfolio_id: portfolioId,
      user_id: userId,
      mandate_id: mandateId ?? null,
      kind: 'suggestion',
      delegation_mode: 'HYBRID_SUGGESTIVE',
      lifecycle_state: 'presented',
      action: raw.action,
      ticker: raw.ticker ?? null,
      notional: raw.notional ?? null,
      currency: raw.currency,
      rationale: raw.rationale,
      assumptions: JSON.stringify(raw.assumptions),
      estimated_broker_fee: frictionEst?.brokerFee ?? null,
      estimated_slippage_cost: frictionEst?.slippageCost ?? null,
      estimated_fx_markup: frictionEst?.fxMarkup ?? null,
      estimated_total_friction: frictionEst?.total ?? null,
      friction_currency: frictionEst?.currency ?? null,
      presented_at: new Date().toISOString(),
      expires_at: expiresAt,
    });

    await this.writeAuditEvent(portfolioId, userId, mandateId, proposalId, 'proposal_presented',
      `Suggestion générée automatiquement (source: ${raw.sourceKind}) — ${raw.rationale.slice(0, 120)}`,
      raw,
    );

    return proposalId;
  }

  private async writeAuditEvent(
    portfolioId: string,
    userId: string,
    mandateId: string | undefined,
    proposalId: string | null,
    kind: 'proposal_presented' | 'guardrail_blocked',
    reason: string,
    raw: RawProposal,
  ) {
    const { data: prev } = await this.supabase.getClient()
      .from('autonomy_audit_events')
      .select('hash')
      .eq('portfolio_id', portfolioId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const prevHash = (prev as { hash: string } | null)?.hash ?? null;
    const eventId = uuid();
    const hash = createHash('sha256')
      .update(`${eventId}|${portfolioId}|${kind}|${reason}|${prevHash ?? ''}`)
      .digest('hex');

    await this.supabase.getClient().from('autonomy_audit_events').insert({
      id: eventId,
      portfolio_id: portfolioId,
      user_id: userId,
      mandate_id: mandateId ?? null,
      proposal_id: proposalId,
      kind,
      delegation_mode: 'HYBRID_SUGGESTIVE',
      action: raw.action,
      ticker: raw.ticker ?? null,
      notional: raw.notional ?? null,
      reason,
      prev_hash: prevHash,
      hash,
    });
  }
}
