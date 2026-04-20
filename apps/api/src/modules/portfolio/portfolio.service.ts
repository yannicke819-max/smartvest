import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class PortfolioService {
  constructor(private readonly supabase: SupabaseService) {}

  async listForUser(userId: string) {
    if (!this.supabase.isReady()) return [];
    const { data, error } = await this.supabase
      .getClient()
      .from('portfolios')
      .select('*, portfolio_accounts(id, kind, label, account_currency, brokers(name, slug))')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async getById(portfolioId: string) {
    if (!this.supabase.isReady()) return null;
    const { data, error } = await this.supabase
      .getClient()
      .from('portfolios')
      .select('*, portfolio_accounts(*, brokers(name, slug))')
      .eq('id', portfolioId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
}
