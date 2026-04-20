import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { FundingAuditService } from './funding-audit.service';
import type {
  CreateTransferDto,
  UpdateTransferDto,
  ListTransfersQueryDto,
  SettleTransferDto,
  CancelTransferDto,
  FailTransferDto,
  ReverseTransferDto,
} from '../dto/funding.dto';

// Mirror of FUNDING_TRANSFER_TRANSITIONS from packages/domain (inlined to avoid
// the Jest moduleNameMapper path issue with @smartvest/domain).
type Status =
  | 'draft'
  | 'initiated'
  | 'pending_settlement'
  | 'settled'
  | 'partially_settled'
  | 'cancelled'
  | 'failed'
  | 'reversed';

const TRANSITIONS: Record<Status, Status[]> = {
  draft: ['initiated', 'cancelled'],
  initiated: ['pending_settlement', 'settled', 'cancelled', 'failed'],
  pending_settlement: ['settled', 'partially_settled', 'failed', 'cancelled'],
  partially_settled: ['settled', 'failed', 'cancelled'],
  settled: ['reversed'],
  cancelled: [],
  failed: ['reversed'],
  reversed: [],
};

function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly audit: FundingAuditService,
  ) {}

  // ------------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------------
  async list(userId: string, filters: ListTransfersQueryDto) {
    let q = this.supabase
      .getClient()
      .from('funding_transfers')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(filters.limit);

    if (filters.status) q = q.eq('status', filters.status);
    if (filters.currency) q = q.eq('currency', filters.currency);
    if (filters.portfolioId) q = q.eq('portfolio_id', filters.portfolioId);
    if (filters.method) q = q.eq('method', filters.method);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async get(id: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_transfers')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Transfert introuvable');
    return data;
  }

  async create(userId: string, dto: CreateTransferDto) {
    // Verify destination exists and belongs to the user
    const { data: dest } = await this.supabase
      .getClient()
      .from('funding_destinations')
      .select('id, currency')
      .eq('id', dto.destinationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!dest) throw new BadRequestException('Destination introuvable ou non autorisée');

    const id = uuid();
    const row = {
      id,
      user_id: userId,
      portfolio_id: dto.portfolioId ?? null,
      portfolio_account_id: dto.portfolioAccountId ?? null,
      source_id: dto.sourceId ?? null,
      destination_id: dto.destinationId,
      status: 'draft' as const,
      method: dto.method,
      currency: dto.currency,
      requested_amount: dto.requestedAmount,
      settled_amount: '0',
      expected_settlement_date: dto.expectedSettlementDate ?? null,
      note: dto.note ?? null,
      metadata: dto.metadata ?? {},
    };

    const { error } = await this.supabase.getClient().from('funding_transfers').insert(row);
    if (error) throw new BadRequestException(error.message);

    await this.audit.write({
      userId,
      kind: 'transfer_created',
      transferId: id,
      newStatus: 'draft',
      amount: dto.requestedAmount,
      currency: dto.currency,
      reason: dto.note ?? null,
    });

    // Optional link to a goal on creation — simple convenience, writes allocation link
    if (dto.linkGoalId) {
      await this.supabase.getClient().from('funding_allocation_links').insert({
        id: uuid(),
        user_id: userId,
        transfer_id: id,
        link_kind: 'goal',
        goal_id: dto.linkGoalId,
        allocated_amount: dto.requestedAmount,
        currency: dto.currency,
      });
      await this.audit.write({
        userId,
        kind: 'allocation_linked',
        transferId: id,
        amount: dto.requestedAmount,
        currency: dto.currency,
        reason: `link:goal:${dto.linkGoalId}`,
      });
    }

    return this.get(id, userId);
  }

  async update(id: string, userId: string, dto: UpdateTransferDto) {
    const current = await this.get(id, userId);
    if (current.status !== 'draft') {
      throw new ConflictException(
        'Seul un transfert en statut "draft" peut être modifié (annulez-le pour repartir).',
      );
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.note !== undefined) patch['note'] = dto.note;
    if (dto.expectedSettlementDate !== undefined)
      patch['expected_settlement_date'] = dto.expectedSettlementDate;
    if (dto.requestedAmount !== undefined) patch['requested_amount'] = dto.requestedAmount;
    if (dto.metadata !== undefined) patch['metadata'] = dto.metadata;

    const { error } = await this.supabase
      .getClient()
      .from('funding_transfers')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);

    await this.audit.write({
      userId,
      kind: 'transfer_updated',
      transferId: id,
      prevStatus: 'draft',
      newStatus: 'draft',
      reason: 'patched',
    });

    return this.get(id, userId);
  }

  // ------------------------------------------------------------------------
  // Transitions
  // ------------------------------------------------------------------------
  async initiate(id: string, userId: string) {
    return this.transition(id, userId, 'initiated', 'transfer_initiated', {
      initiated_at: new Date().toISOString(),
    });
  }

  async settle(id: string, userId: string, dto: SettleTransferDto) {
    const current = await this.get(id, userId);
    const currentStatus = current.status as Status;
    // Determine target status: partial if settledAmount < requestedAmount
    const requested = Number(current.requested_amount);
    const settledAmount = dto.settledAmount ?? current.requested_amount;
    const settled = Number(settledAmount);
    if (!Number.isFinite(settled) || settled <= 0)
      throw new BadRequestException('settledAmount invalide');
    if (settled > requested)
      throw new BadRequestException('settledAmount ne peut dépasser requested_amount');

    const target: Status = settled < requested ? 'partially_settled' : 'settled';
    const auditKind = target === 'partially_settled' ? 'transfer_partially_settled' : 'transfer_settled';

    if (!canTransition(currentStatus, target)) {
      throw new ConflictException(
        `Transition invalide : ${currentStatus} → ${target}`,
      );
    }

    return this.applyTransition(id, userId, current, target, auditKind, {
      settled_amount: settledAmount,
      settled_at: dto.settledAt ?? new Date().toISOString(),
    });
  }

  async cancel(id: string, userId: string, dto: CancelTransferDto) {
    return this.transition(id, userId, 'cancelled', 'transfer_cancelled', {
      cancelled_at: new Date().toISOString(),
    }, dto.reason);
  }

  async fail(id: string, userId: string, dto: FailTransferDto) {
    return this.transition(id, userId, 'failed', 'transfer_failed', {
      failed_at: new Date().toISOString(),
      failure_reason: dto.reason,
    }, dto.reason);
  }

  async reverse(id: string, userId: string, dto: ReverseTransferDto) {
    return this.transition(id, userId, 'reversed', 'transfer_reversed', {
      reversed_at: new Date().toISOString(),
      reversal_reason: dto.reason,
    }, dto.reason);
  }

  // ------------------------------------------------------------------------
  // Audit
  // ------------------------------------------------------------------------
  async listAudit(id: string, userId: string) {
    await this.get(id, userId); // authZ check
    return this.audit.listForTransfer(id, userId);
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------
  private async transition(
    id: string,
    userId: string,
    target: Status,
    auditKind: Parameters<FundingAuditService['write']>[0]['kind'],
    extraPatch: Record<string, unknown>,
    reason?: string,
  ) {
    const current = await this.get(id, userId);
    const from = current.status as Status;
    if (!canTransition(from, target)) {
      throw new ConflictException(`Transition invalide : ${from} → ${target}`);
    }
    return this.applyTransition(id, userId, current, target, auditKind, extraPatch, reason);
  }

  private async applyTransition(
    id: string,
    userId: string,
    current: Record<string, unknown>,
    target: Status,
    auditKind: Parameters<FundingAuditService['write']>[0]['kind'],
    extraPatch: Record<string, unknown>,
    reason?: string,
  ) {
    const patch: Record<string, unknown> = {
      status: target,
      updated_at: new Date().toISOString(),
      ...extraPatch,
    };

    const { error } = await this.supabase
      .getClient()
      .from('funding_transfers')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);

    await this.audit.write({
      userId,
      kind: auditKind,
      transferId: id,
      prevStatus: current['status'] as string,
      newStatus: target,
      amount: (current['requested_amount'] as string) ?? null,
      currency: (current['currency'] as string) ?? null,
      ...(reason !== undefined ? { reason } : {}),
    });

    this.logger.log(`Transfer ${id}: ${current['status']} → ${target}`);
    return this.get(id, userId);
  }
}
