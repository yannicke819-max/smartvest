'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

interface CreatePaperPortfolioPayload {
  name?: string;
  baseCurrency?: string;
  initialCapital?: number;
}

export async function createPaperPortfolio(
  payload: CreatePaperPortfolioPayload = {},
): Promise<{ portfolioId: string }> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Utilisateur non authentifié.');

  const name = payload.name ?? 'Simulation SmartVest';
  const baseCurrency = payload.baseCurrency ?? 'EUR';
  const initialCapital = payload.initialCapital ?? 10000;

  const { data: existing } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .eq('is_simulation', true)
    .limit(1)
    .single();
  if (existing) throw new Error('Un portefeuille de simulation existe déjà.');

  await supabase.from('user_profiles').upsert(
    { id: user.id, updated_at: new Date().toISOString() },
    { onConflict: 'id', ignoreDuplicates: true },
  );

  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios')
    .insert({
      user_id: user.id,
      name,
      base_currency: baseCurrency,
      description: `Simulation — ${initialCapital.toLocaleString('fr-FR')} ${baseCurrency} virtuels. Aucune exécution réelle.`,
      is_simulation: true,
      simulation_initial_capital: initialCapital.toFixed(2),
    })
    .select('id')
    .single();
  if (pErr || !portfolio) throw new Error(`Portefeuille: ${pErr?.message}`);

  const { error: aErr } = await supabase
    .from('portfolio_accounts')
    .insert({
      portfolio_id: portfolio.id,
      kind: 'cash',
      label: 'Cash simulation',
      account_currency: baseCurrency,
    });
  if (aErr) throw new Error(`Compte: ${aErr.message}`);

  return { portfolioId: portfolio.id };
}

/** Garde uniquement le portefeuille de simulation le plus récent, supprime les doublons. */
export async function deduplicateSimulationPortfolios(): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Utilisateur non authentifié.');

  const { data: sims } = await supabase
    .from('portfolios')
    .select('id, created_at')
    .eq('user_id', user.id)
    .eq('is_simulation', true)
    .order('created_at', { ascending: false });

  if (!sims || sims.length <= 1) return 0;

  const toDelete = sims.slice(1).map((p) => p.id);
  await supabase.from('portfolios').delete().in('id', toDelete).eq('user_id', user.id);
  return toDelete.length;
}
