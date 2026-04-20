import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { SupabaseService } from '../../supabase/supabase.service';
import type { ListLedgerQueryDto } from '../dto/cash.dto';

interface BalanceRow {
  id: string;
  destination_id: string;
  currency: string;
  settled: string;
  pending_in: string;
  reserved: string;
  updated_at: string;
}

/**
 * Read-only views over cash_balances + cash_ledger_entries.
 * Balance mutations live in CashLedgerService.
 */
@Injectable()
export class CashBalancesService {
  constructor(private readonly supabase: SupabaseService) {}

  /** All balances for a user, with derived `available` = settled − reserved. */
  async listForUser(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('cash_balances')
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return (data ?? []).map((b) => this.withAvailable(b as BalanceRow));
  }

  async getForDestination(destinationId: string, userId: string, currency?: string) {
    let q = this.supabase
      .getClient()
      .from('cash_balances')
      .select('*')
      .eq('destination_id', destinationId)
      .eq('user_id', userId);
    if (currency) q = q.eq('currency', currency);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    if (!data || data.length === 0) throw new NotFoundException('Aucun solde pour ce compte');
    return data.map((b) => this.withAvailable(b as BalanceRow));
  }

  /**
   * Aggregate KPIs for dashboard: one row per currency summing across all
   * destinations (for a user). Useful for the "Cash & funding" widget.
   */
  async summary(userId: string) {
    const balances = await this.listForUser(userId);
    const byCurrency = new Map<
      string,
      { settled: Decimal; pendingIn: Decimal; reserved: Decimal }
    >();

    for (const b of balances) {
      const cur = byCurrency.get(b.currency) ?? {
        settled: new Decimal(0),
        pendingIn: new Decimal(0),
        reserved: new Decimal(0),
      };
      cur.settled = cur.settled.plus(b.settled);
      cur.pendingIn = cur.pendingIn.plus(b.pending_in);
      cur.reserved = cur.reserved.plus(b.reserved);
      byCurrency.set(b.currency, cur);
    }

    return Array.from(byCurrency.entries()).map(([currency, v]) => ({
      currency,
      settled: v.settled.toFixed(2),
      pending_in: v.pendingIn.toFixed(2),
      reserved: v.reserved.toFixed(2),
      available: v.settled.minus(v.reserved).toFixed(2),
    }));
  }

  async listLedger(userId: string, filters: ListLedgerQueryDto) {
    let q = this.supabase
      .getClient()
      .from('cash_ledger_entries')
      .select('*')
      .eq('user_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(filters.limit);
    if (filters.destinationId) q = q.eq('destination_id', filters.destinationId);
    if (filters.currency) q = q.eq('currency', filters.currency);
    if (filters.movementType) q = q.eq('movement_type', filters.movementType);

    const { data, error } = await q;
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  private withAvailable(b: BalanceRow) {
    const available = new Decimal(b.settled).minus(b.reserved).toFixed(10);
    return { ...b, available };
  }
}
