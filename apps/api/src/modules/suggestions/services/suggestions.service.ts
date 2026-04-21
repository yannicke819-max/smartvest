import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import type {
  ApproveProposalDto,
  RejectProposalDto,
  CancelProposalDto,
  ListProposalsQuery,
} from '../dto/suggestions.dto';

type ProposalAuditKind =
  | 'proposal_presented'
  | 'proposal_approved'
  | 'proposal_rejected';

@Injectable()
export class SuggestionsService {
  constructor(private readonly supabase: SupabaseService) {}

  async listProposals(userId: string, query: ListProposalsQuery) {
    let q = this.supabase.getClient()
      .from('action_proposals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(query.limit);
    if (query.portfolioId) q = q.eq('portfolio_id', query.portfolioId);
    if (query.lifecycleState) q = q.eq('lifecycle_state', query.lifecycleState);
    if (query.kind) q = q.eq('kind', query.kind);
    if (query.action) q = q.eq('action', query.action);
    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async getProposal(id: string, userId: string) {
    const { data, error } = await this.supabase.getClient()
      .from('action_proposals')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Proposition introuvable');
    return data;
  }

  async approveProposal(id: string, userId: string, dto: ApproveProposalDto) {
    const existing = await this.getProposal(id, userId) as Record<string, unknown>;
    const state = existing['lifecycle_state'] as string;
    if (state !== 'presented' && state !== 'draft') {
      throw new ConflictException(`Impossible d'approuver une proposition à l'état "${state}"`);
    }

    // Insert approval record
    await this.supabase.getClient().from('action_approvals').insert({
      id: uuid(),
      proposal_id: id,
      user_id: userId,
      decision: 'approved',
      modified_quantity: dto.modifiedQuantity ?? null,
      modified_notional: dto.modifiedNotional ?? null,
      note: dto.note ?? null,
    });

    // Update proposal lifecycle — approved, NOT executed (HYBRID stops here)
    const { data, error } = await this.supabase.getClient()
      .from('action_proposals')
      .update({ lifecycle_state: 'approved', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Approbation impossible');

    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      proposalId: id,
      kind: 'proposal_approved',
      action: existing['action'] as string,
      ticker: (existing['ticker'] as string | null) ?? null,
      notional: (existing['notional'] as string | null) ?? null,
      reason: dto.note ?? `Proposition approuvée — intention validée (aucune exécution broker)`,
    });
    return data;
  }

  async rejectProposal(id: string, userId: string, dto: RejectProposalDto) {
    const existing = await this.getProposal(id, userId) as Record<string, unknown>;
    const state = existing['lifecycle_state'] as string;
    if (state !== 'presented' && state !== 'draft') {
      throw new ConflictException(`Impossible de rejeter une proposition à l'état "${state}"`);
    }

    await this.supabase.getClient().from('action_approvals').insert({
      id: uuid(),
      proposal_id: id,
      user_id: userId,
      decision: 'rejected',
      note: dto.note ?? null,
    });

    const { data, error } = await this.supabase.getClient()
      .from('action_proposals')
      .update({ lifecycle_state: 'rejected', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Rejet impossible');

    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      proposalId: id,
      kind: 'proposal_rejected',
      action: existing['action'] as string,
      ticker: (existing['ticker'] as string | null) ?? null,
      notional: (existing['notional'] as string | null) ?? null,
      reason: dto.note ?? 'Proposition rejetée par l\'utilisateur',
    });
    return data;
  }

  async cancelProposal(id: string, userId: string, dto: CancelProposalDto) {
    const existing = await this.getProposal(id, userId) as Record<string, unknown>;
    const state = existing['lifecycle_state'] as string;
    const terminal = ['approved', 'rejected', 'executed', 'cancelled', 'expired'];
    if (terminal.includes(state)) {
      throw new ConflictException(`Impossible d'annuler une proposition à l'état "${state}"`);
    }

    const { data, error } = await this.supabase.getClient()
      .from('action_proposals')
      .update({ lifecycle_state: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new BadRequestException(error?.message ?? 'Annulation impossible');

    // DB kind check doesn't include proposal_cancelled — reuse proposal_rejected with cancellation reason
    await this.writeAuditEvent({
      portfolioId: existing['portfolio_id'] as string,
      userId,
      proposalId: id,
      kind: 'proposal_rejected',
      action: existing['action'] as string,
      ticker: (existing['ticker'] as string | null) ?? null,
      notional: (existing['notional'] as string | null) ?? null,
      reason: dto.reason ?? 'Proposition annulée (retirée avant décision) par l\'utilisateur',
    });
    return data;
  }

  async getProposalAudit(id: string, userId: string) {
    const existing = await this.getProposal(id, userId) as Record<string, unknown>;
    const { data, error } = await this.supabase.getClient()
      .from('autonomy_audit_events')
      .select('*')
      .eq('portfolio_id', existing['portfolio_id'] as string)
      .eq('proposal_id', id)
      .order('occurred_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async countPending(userId: string, portfolioId?: string) {
    let q = this.supabase.getClient()
      .from('action_proposals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('lifecycle_state', 'presented');
    if (portfolioId) q = q.eq('portfolio_id', portfolioId);
    const { count, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return { count: count ?? 0 };
  }

  private async writeAuditEvent(params: {
    portfolioId: string;
    userId: string;
    proposalId: string;
    kind: ProposalAuditKind;
    action: string;
    ticker: string | null;
    notional: string | null;
    reason: string;
  }) {
    const { portfolioId, userId, proposalId, kind, action, ticker, notional, reason } = params;
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
      proposal_id: proposalId,
      kind,
      delegation_mode: 'HYBRID_SUGGESTIVE',
      action,
      ticker,
      notional,
      reason,
      prev_hash: prevHash,
      hash,
    });
  }
}
