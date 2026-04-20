import { Injectable, ForbiddenException } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import type { AutonomyMandate } from '@smartvest/domain';
import { SupabaseService } from '../../supabase/supabase.service';

// Inlined from @smartvest/domain checkMandatePermission — avoids Jest module-resolver
// issues with value imports while keeping the logic identical and co-located with its use.
function checkMandate(mandate: AutonomyMandate): string | null {
  if (mandate.killSwitchActive) return 'kill-switch actif';
  if (mandate.status !== 'active') return `mandat non actif (statut: ${mandate.status})`;
  if (new Date(mandate.expiresAt) <= new Date()) return 'mandat expiré';
  return null;
}

@Injectable()
export class GoalAuditService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Gate for plan → suggestion conversions.
   *
   * MANUAL_EXPLICIT: always permitted — suggestion is non-binding, no mandate required.
   * HYBRID_SUGGESTIVE / AUTONOMOUS_GUARDED: requires an active, non-expired mandate with
   *   kill-switch off. Blocks if absent.
   *
   * Always emits a hash-chained AutonomyAuditEvent (proposal_presented or policy_violation).
   * The audit event is written BEFORE throwing so the refusal is permanently recorded.
   */
  async checkAndAuditConversion(params: {
    portfolioId: string;
    userId: string;
    goalId: string;
    scenarioId: string;
    delegationMode: string;
  }): Promise<void> {
    const { portfolioId, userId, goalId, scenarioId, delegationMode } = params;
    const now = new Date().toISOString();

    let mandateId: string | null = null;
    let blockedReason: string | null = null;

    if (delegationMode !== 'MANUAL_EXPLICIT') {
      const { data: row } = await this.supabase.getClient()
        .from('autonomy_mandates')
        .select('*')
        .eq('portfolio_id', portfolioId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!row) {
        blockedReason = `Aucun mandat d'autonomie actif pour le portefeuille (mode requis: ${delegationMode})`;
      } else {
        mandateId = row.id as string;
        blockedReason = checkMandate(this.mapRow(row));
      }
    }

    const prevHash = await this.getLastHash(portfolioId);
    const eventId = uuid();
    const kind = blockedReason ? 'policy_violation' : 'proposal_presented';
    const reason = blockedReason
      ?? `Conversion scénario ${scenarioId} → suggestion (mode: ${delegationMode}, goal: ${goalId})`;

    const hash = createHash('sha256')
      .update(`${eventId}|${portfolioId}|${kind}|${reason}|${prevHash ?? ''}`)
      .digest('hex');

    // Write audit event BEFORE throwing — refusal must be auditable
    await this.supabase.getClient().from('autonomy_audit_events').insert({
      id: eventId,
      portfolio_id: portfolioId,
      user_id: userId,
      mandate_id: mandateId,
      proposal_id: null,
      kind,
      delegation_mode: delegationMode,
      portfolio_value_at_event: null,
      portfolio_currency: null,
      action: `convert_to_suggestion:goal=${goalId}:scenario=${scenarioId}`,
      ticker: null,
      notional: null,
      reason,
      guardrail_field: null,
      guardrail_value: null,
      guardrail_limit: null,
      prev_hash: prevHash,
      hash,
      occurred_at: now,
    });

    if (blockedReason) {
      throw new ForbiddenException(blockedReason);
    }
  }

  private async getLastHash(portfolioId: string): Promise<string | null> {
    const { data } = await this.supabase.getClient()
      .from('autonomy_audit_events')
      .select('hash')
      .eq('portfolio_id', portfolioId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .single();
    return (data as { hash: string } | null)?.hash ?? null;
  }

  private mapRow(row: Record<string, unknown>): AutonomyMandate {
    return {
      id: row.id as string,
      portfolioId: row.portfolio_id as string,
      userId: row.user_id as string,
      status: row.status as AutonomyMandate['status'],
      label: row.label as string,
      guardrail: {
        maxPositionSizePct: Number(row.max_position_size_pct),
        maxSingleTradePct: Number(row.max_single_trade_pct),
        maxDailyTradePct: Number(row.max_daily_trade_pct),
        maxSingleTradeNotional: (row.max_single_trade_notional as string | null),
        maxSingleTradeNotionalCurrency: (row.max_single_trade_notional_currency as string | null),
        allowedAssetClasses: (row.allowed_asset_classes as string[]) ?? [],
        forbiddenTickers: (row.forbidden_tickers as string[]) ?? [],
        requiresHumanAbovePct: Number(row.requires_human_above_pct),
        stopLossTriggerPct: Number(row.stop_loss_trigger_pct),
        maxOpenPositions: row.max_open_positions != null ? Number(row.max_open_positions) : null,
      },
      activatedAt: (row.activated_at as string | null),
      expiresAt: row.expires_at as string,
      suspendedAt: (row.suspended_at as string | null),
      revokedAt: (row.revoked_at as string | null),
      killSwitchActive: Boolean(row.kill_switch_active),
      totalActionsExecuted: Number(row.total_actions_executed ?? 0),
      totalNotionalTraded: String(row.total_notional_traded ?? '0'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
