'use server';

import { createSupabaseServerClient } from '@/lib/supabase/server';

interface CreatePaperPortfolioPayload {
  name?: string;
  baseCurrency?: string;
  initialCapital?: number;
}

/**
 * Crée un portefeuille de simulation 100% virtuel — aucune connexion broker,
 * aucun ordre réel, données marquées explicitement `is_simulation = true`.
 *
 * Cas d'usage : tester des stratégies d'investissement, laisser l'analyste IA
 * proposer des scénarios, observer la performance sur un corpus de règles
 * empiriques — sans engager le moindre capital réel.
 */
export async function createPaperPortfolio(
  payload: CreatePaperPortfolioPayload = {},
): Promise<{ portfolioId: string }> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Utilisateur non authentifié.');

  const name = payload.name ?? 'Simulation SmartVest';
  const baseCurrency = payload.baseCurrency ?? 'EUR';
  const initialCapital = payload.initialCapital ?? 10000;

  // Refuse si un portefeuille de simulation existe déjà.
  const { data: existing } = await supabase
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .eq('is_simulation', true)
    .limit(1)
    .single();
  if (existing) throw new Error('Un portefeuille de simulation existe déjà. Supprime-le avant d\'en créer un nouveau.');

  // S'assurer qu'un user_profile existe (cas Google OAuth récent).
  await supabase.from('user_profiles').upsert(
    { id: user.id, updated_at: new Date().toISOString() },
    { onConflict: 'id', ignoreDuplicates: true },
  );

  // 1. Portefeuille virtuel
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

  // 2. Compte cash associé (pour tracker la balance virtuelle)
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
