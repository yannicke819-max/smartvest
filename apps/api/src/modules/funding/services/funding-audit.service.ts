import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';

export type FundingAuditKind =
  | 'transfer_created'
  | 'transfer_updated'
  | 'transfer_initiated'
  | 'transfer_settled'
  | 'transfer_partially_settled'
  | 'transfer_cancelled'
  | 'transfer_failed'
  | 'transfer_reversed'
  | 'reservation_created'
  | 'reservation_released'
  | 'reservation_consumed'
  | 'allocation_linked'
  | 'allocation_unlinked'
  | 'cash_adjustment';

export interface FundingAuditInput {
  userId: string;
  kind: FundingAuditKind;
  transferId?: string | null;
  reservationId?: string | null;
  prevStatus?: string | null;
  newStatus?: string | null;
  amount?: string | null;
  currency?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes hash-chained audit events for every funding transition.
 * Chain: hash = sha256(eventId | userId | kind | reason | prevHash)
 * mirrors autonomy_audit_events to keep one verification routine usable
 * across both subsystems.
 */
@Injectable()
export class FundingAuditService {
  constructor(private readonly supabase: SupabaseService) {}

  async write(input: FundingAuditInput): Promise<string> {
    const { data: prev } = await this.supabase
      .getClient()
      .from('funding_audit_events')
      .select('hash')
      .eq('user_id', input.userId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = (prev as { hash: string } | null)?.hash ?? null;
    const eventId = uuid();
    const hash = createHash('sha256')
      .update(`${eventId}|${input.userId}|${input.kind}|${input.reason ?? ''}|${prevHash ?? ''}`)
      .digest('hex');

    await this.supabase.getClient().from('funding_audit_events').insert({
      id: eventId,
      user_id: input.userId,
      transfer_id: input.transferId ?? null,
      reservation_id: input.reservationId ?? null,
      kind: input.kind,
      prev_status: input.prevStatus ?? null,
      new_status: input.newStatus ?? null,
      amount: input.amount ?? null,
      currency: input.currency ?? null,
      reason: input.reason ?? null,
      prev_hash: prevHash,
      hash,
      metadata: input.metadata ?? {},
    });

    return eventId;
  }

  async listForTransfer(transferId: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_audit_events')
      .select('*')
      .eq('user_id', userId)
      .eq('transfer_id', transferId)
      .order('occurred_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
