import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

export type MovementType =
  | 'deposit'
  | 'withdrawal'
  | 'transfer_in'
  | 'transfer_out'
  | 'settlement_credit'
  | 'settlement_debit'
  | 'reservation'
  | 'reservation_release'
  | 'adjustment';

export interface LedgerRecordInput {
  userId: string;
  destinationId: string;
  currency: string;
  movementType: MovementType;
  /** Signed amount for settled mutations. Always positive for reservation ops
   *  (the movement_type disambiguates which bucket is affected). */
  amount: string;
  transferId?: string | null;
  reservationId?: string | null;
  description?: string | null;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

interface BalanceRow {
  id: string;
  user_id: string;
  destination_id: string;
  currency: string;
  settled: string;
  pending_in: string;
  reserved: string;
  updated_at: string;
}

/** Which movement types affect `settled` (signed) vs `reserved` (positive). */
const AFFECTS_SETTLED: ReadonlySet<MovementType> = new Set([
  'deposit',
  'withdrawal',
  'transfer_in',
  'transfer_out',
  'settlement_credit',
  'settlement_debit',
  'adjustment',
]);
const AFFECTS_RESERVED_PLUS: ReadonlySet<MovementType> = new Set(['reservation']);
const AFFECTS_RESERVED_MINUS: ReadonlySet<MovementType> = new Set([
  'reservation_release',
]);

/**
 * CashLedgerService — append-only journal of every cash movement.
 * Every `record()` call writes one row to cash_ledger_entries and updates
 * cash_balances atomically (from the app's perspective; we do sequential writes,
 * ledger first — an orphan journal entry can always be replayed to fix a stale
 * balance, but a stale balance with no journal is unrecoverable).
 */
@Injectable()
export class CashLedgerService {
  private readonly logger = new Logger(CashLedgerService.name);

  constructor(private readonly supabase: SupabaseService) {}

  /** Write a ledger entry and mutate the denormalised balance. */
  async record(input: LedgerRecordInput) {
    const balance = await this.loadOrInitBalance(
      input.userId,
      input.destinationId,
      input.currency,
    );

    const amount = new Decimal(input.amount);
    let nextSettled = new Decimal(balance.settled);
    let nextReserved = new Decimal(balance.reserved);

    if (AFFECTS_SETTLED.has(input.movementType)) {
      nextSettled = nextSettled.plus(amount); // amount is already signed
    } else if (AFFECTS_RESERVED_PLUS.has(input.movementType)) {
      nextReserved = nextReserved.plus(amount.abs());
    } else if (AFFECTS_RESERVED_MINUS.has(input.movementType)) {
      nextReserved = nextReserved.minus(amount.abs());
      if (nextReserved.isNegative()) {
        throw new BadRequestException('Libération supérieure au cash réservé disponible');
      }
    }

    if (nextSettled.isNegative()) {
      throw new BadRequestException('Solde settled négatif interdit');
    }

    const entryId = uuid();
    const { error: ledgerError } = await this.supabase
      .getClient()
      .from('cash_ledger_entries')
      .insert({
        id: entryId,
        user_id: input.userId,
        destination_id: input.destinationId,
        currency: input.currency,
        movement_type: input.movementType,
        amount: input.amount,
        transfer_id: input.transferId ?? null,
        reservation_id: input.reservationId ?? null,
        balance_after: nextSettled.toFixed(10),
        description: input.description ?? null,
        metadata: input.metadata ?? {},
        occurred_at: input.occurredAt ?? new Date().toISOString(),
      });
    if (ledgerError) throw new BadRequestException(ledgerError.message);

    const { error: balanceError } = await this.supabase
      .getClient()
      .from('cash_balances')
      .upsert(
        {
          id: balance.id,
          user_id: input.userId,
          destination_id: input.destinationId,
          currency: input.currency,
          settled: nextSettled.toFixed(10),
          pending_in: balance.pending_in,
          reserved: nextReserved.toFixed(10),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'destination_id,currency' },
      );
    if (balanceError) throw new BadRequestException(balanceError.message);

    this.logger.log(
      `[${input.movementType}] ${input.destinationId}/${input.currency} amount=${input.amount} → settled=${nextSettled.toFixed(2)} reserved=${nextReserved.toFixed(2)}`,
    );
    return entryId;
  }

  /** Update pending_in only (no ledger entry — pending is forecast, not accounting). */
  async adjustPendingIn(
    userId: string,
    destinationId: string,
    currency: string,
    signedAmount: string,
  ) {
    const balance = await this.loadOrInitBalance(userId, destinationId, currency);
    const next = new Decimal(balance.pending_in).plus(new Decimal(signedAmount));
    const nextStr = (next.isNegative() ? new Decimal(0) : next).toFixed(10);

    const { error } = await this.supabase
      .getClient()
      .from('cash_balances')
      .upsert(
        {
          id: balance.id,
          user_id: userId,
          destination_id: destinationId,
          currency,
          settled: balance.settled,
          pending_in: nextStr,
          reserved: balance.reserved,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'destination_id,currency' },
      );
    if (error) throw new BadRequestException(error.message);
  }

  private async loadOrInitBalance(
    userId: string,
    destinationId: string,
    currency: string,
  ): Promise<BalanceRow> {
    const { data } = await this.supabase
      .getClient()
      .from('cash_balances')
      .select('*')
      .eq('destination_id', destinationId)
      .eq('currency', currency)
      .maybeSingle();

    if (data) return data as BalanceRow;

    // Initialise a zero-balance row lazily on first touch
    return {
      id: uuid(),
      user_id: userId,
      destination_id: destinationId,
      currency,
      settled: '0',
      pending_in: '0',
      reserved: '0',
      updated_at: new Date().toISOString(),
    };
  }
}
