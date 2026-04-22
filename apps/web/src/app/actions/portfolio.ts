'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface CreatePortfolioInput {
  name: string;
  baseCurrency: string;
  description?: string;
}

export async function createPortfolio(input: CreatePortfolioInput) {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Non authentifié.');

  const { data, error } = await supabase
    .from('portfolios')
    .insert({ user_id: user.id, name: input.name, base_currency: input.baseCurrency, description: input.description ?? null })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deletePortfolio(portfolioId: string) {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Non authentifié.');

  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id, user_id')
    .eq('id', portfolioId)
    .eq('user_id', user.id)
    .single();
  if (!portfolio) throw new Error('Portefeuille non trouvé.');

  const { error } = await supabase.from('portfolios').delete().eq('id', portfolioId).eq('user_id', user.id);
  if (error) throw new Error(error.message);
}

export interface CreateAccountInput {
  portfolioId: string;
  label: string;
  kind: string;
  accountCurrency: string;
  brokerId?: string;
  externalRef?: string;
}

export async function createAccount(input: CreateAccountInput) {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Non authentifié.');

  // Vérifier que le portefeuille appartient à l'utilisateur
  const { data: portfolio } = await supabase
    .from('portfolios')
    .select('id')
    .eq('id', input.portfolioId)
    .eq('user_id', user.id)
    .single();
  if (!portfolio) throw new Error('Portefeuille non trouvé.');

  const { data, error } = await supabase
    .from('portfolio_accounts')
    .insert({
      portfolio_id: input.portfolioId,
      label: input.label,
      kind: input.kind,
      account_currency: input.accountCurrency,
      broker_id: input.brokerId ?? null,
      external_ref: input.externalRef ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}
