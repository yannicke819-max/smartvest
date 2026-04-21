import { Injectable, BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import { CashLedgerService } from './cash-ledger.service';
import { FundingAuditService } from './funding-audit.service';
import type { CreateReservationDto, ListReservationsQueryDto } from '../dto/cash.dto';

@Injectable()
export class CashReservationsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ledger: CashLedgerService,
    private readonly audit: FundingAuditService,
  ) {}

  async list(userId: string, filters: ListReservationsQueryDto) {
    let q = this.supabase
      .getClient()
      .from('cash_reservations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (filters.destinationId) q = q.eq('destination_id', filters.destinationId);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.goalId) q = q.eq('goal_id', filters.goalId);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async get(id: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('cash_reservations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Réservation introuvable');
    return data;
  }

  async create(userId: string, dto: CreateReservationDto) {
    // Verify enough available cash before reserving
    const { data: balance } = await this.supabase
      .getClient()
      .from('cash_balances')
      .select('settled, reserved')
      .eq('destination_id', dto.destinationId)
      .eq('currency', dto.currency)
      .maybeSingle();

    const settled = new Decimal((balance as { settled: string } | null)?.settled ?? '0');
    const reserved = new Decimal((balance as { reserved: string } | null)?.reserved ?? '0');
    const available = settled.minus(reserved);
    const requested = new Decimal(dto.amount);

    if (requested.gt(available)) {
      throw new ConflictException(
        `Cash disponible insuffisant (${available.toFixed(2)} < ${requested.toFixed(2)})`,
      );
    }

    const id = uuid();
    const { error } = await this.supabase.getClient().from('cash_reservations').insert({
      id,
      user_id: userId,
      destination_id: dto.destinationId,
      currency: dto.currency,
      amount: dto.amount,
      status: 'active',
      goal_id: dto.goalId ?? null,
      proposal_id: dto.proposalId ?? null,
      plan_id: dto.planId ?? null,
      reason: dto.reason,
      expires_at: dto.expiresAt ?? null,
      metadata: dto.metadata ?? {},
    });
    if (error) throw new BadRequestException(error.message);

    // Ledger entry (reservation — affects `reserved`, not `settled`)
    await this.ledger.record({
      userId,
      destinationId: dto.destinationId,
      currency: dto.currency,
      movementType: 'reservation',
      amount: dto.amount,
      reservationId: id,
      description: dto.reason,
    });

    await this.audit.write({
      userId,
      kind: 'reservation_created',
      reservationId: id,
      amount: dto.amount,
      currency: dto.currency,
      reason: dto.reason,
    });

    return this.get(id, userId);
  }

  async release(id: string, userId: string) {
    const current = await this.get(id, userId);
    if (current.status !== 'active') {
      throw new ConflictException(
        `Réservation non active (statut: ${current.status}) — impossible à libérer`,
      );
    }

    const { error } = await this.supabase
      .getClient()
      .from('cash_reservations')
      .update({
        status: 'released',
        released_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);

    await this.ledger.record({
      userId,
      destinationId: current.destination_id as string,
      currency: current.currency as string,
      movementType: 'reservation_release',
      amount: current.amount as string,
      reservationId: id,
      description: `Libération : ${current.reason as string}`,
    });

    await this.audit.write({
      userId,
      kind: 'reservation_released',
      reservationId: id,
      amount: current.amount as string,
      currency: current.currency as string,
      reason: current.reason as string,
    });

    return this.get(id, userId);
  }

  /** Marks a reservation as consumed (e.g. allocation-link accepted).
   * The reserved cash is moved out — caller must have already debited settled
   * via ledger.record(withdrawal/adjustment) if applicable. */
  async consume(id: string, userId: string) {
    const current = await this.get(id, userId);
    if (current.status !== 'active') {
      throw new ConflictException(
        `Réservation non active (statut: ${current.status})`,
      );
    }

    await this.supabase
      .getClient()
      .from('cash_reservations')
      .update({
        status: 'consumed',
        consumed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId);

    await this.ledger.record({
      userId,
      destinationId: current.destination_id as string,
      currency: current.currency as string,
      movementType: 'reservation_release',
      amount: current.amount as string,
      reservationId: id,
      description: `Consommation : ${current.reason as string}`,
    });

    await this.audit.write({
      userId,
      kind: 'reservation_consumed',
      reservationId: id,
      amount: current.amount as string,
      currency: current.currency as string,
      reason: current.reason as string,
    });

    return this.get(id, userId);
  }
}
