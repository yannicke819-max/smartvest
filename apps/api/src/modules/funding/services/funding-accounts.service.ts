import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import type { CreateFundingSourceDto, CreateFundingDestinationDto } from '../dto/funding.dto';

/**
 * Thin CRUD over funding_sources and funding_destinations.
 * Sources = user-declared bank accounts (never authoritative, just labels).
 * Destinations = investment accounts that can receive funds.
 */
@Injectable()
export class FundingAccountsService {
  constructor(private readonly supabase: SupabaseService) {}

  // ----- Sources -----
  async listSources(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_sources')
      .select('*')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async createSource(userId: string, dto: CreateFundingSourceDto) {
    const id = uuid();
    const { error } = await this.supabase.getClient().from('funding_sources').insert({
      id,
      user_id: userId,
      label: dto.label,
      iban_last4: dto.ibanLast4 ?? null,
      bank_name: dto.bankName ?? null,
      currency: dto.currency,
      metadata: dto.metadata ?? {},
    });
    if (error) throw new BadRequestException(error.message);
    return this.getSource(id, userId);
  }

  async getSource(id: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_sources')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Source introuvable');
    return data;
  }

  async archiveSource(id: string, userId: string) {
    const { error } = await this.supabase
      .getClient()
      .from('funding_sources')
      .update({ is_archived: true, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  // ----- Destinations -----
  async listDestinations(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_destinations')
      .select('*')
      .eq('user_id', userId)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });
    if (error) throw new BadRequestException(error.message);
    return data ?? [];
  }

  async createDestination(userId: string, dto: CreateFundingDestinationDto) {
    const id = uuid();
    const { error } = await this.supabase.getClient().from('funding_destinations').insert({
      id,
      user_id: userId,
      label: dto.label,
      portfolio_id: dto.portfolioId ?? null,
      portfolio_account_id: dto.portfolioAccountId ?? null,
      broker_account_ref: dto.brokerAccountRef ?? null,
      currency: dto.currency,
      metadata: dto.metadata ?? {},
    });
    if (error) throw new BadRequestException(error.message);
    return this.getDestination(id, userId);
  }

  async getDestination(id: string, userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('funding_destinations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Destination introuvable');
    return data;
  }
}
