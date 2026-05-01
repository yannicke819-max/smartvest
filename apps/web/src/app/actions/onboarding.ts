'use server';

import { cookies } from 'next/headers';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { RiskProfileId } from '@smartvest/domain';
import type { PortfolioType, ExperienceLevel, ToleranceOption } from '@smartvest/shared-types';
import type { ProfileScoreResult } from '@smartvest/portfolio-engine';

const ONBOARDING_COOKIE = 'sv_onboarded_v1';

export async function completeOnboarding(
  level: ExperienceLevel,
  tolerance: ToleranceOption,
): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Utilisateur non authentifié.');

  await supabase.from('user_onboarding').upsert({
    user_id: user.id,
    level,
    risk_tolerance: tolerance,
    completed_at: new Date().toISOString(),
    skipped_at: null,
    updated_at: new Date().toISOString(),
  });

  // Cookie 30 jours — middleware guard lira ce cookie.
  const jar = await cookies();
  jar.set(ONBOARDING_COOKIE, 'done', {
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
    sameSite: 'lax',
    httpOnly: true,
  });
}

export async function skipOnboarding(): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    await supabase.from('user_onboarding').upsert({
      user_id: user.id,
      skipped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  // Cookie session uniquement (pas de maxAge) → effacé à la fermeture du navigateur.
  const jar = await cookies();
  jar.set(ONBOARDING_COOKIE, 'skipped', {
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
  });
}

interface OnboardingPayload {
  baseCurrency: string;
  riskProfile: RiskProfileId;
  scoreResult: ProfileScoreResult;
  portfolioName: string;
  portfolioType: PortfolioType;
}

export async function submitOnboarding(payload: OnboardingPayload): Promise<{ portfolioId: string }> {
  const supabase = createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) throw new Error('Utilisateur non authentifié.');

  // 1. Upsert profil utilisateur
  const { error: profileError } = await supabase.from('user_profiles').upsert({
    id: user.id,
    base_currency: payload.baseCurrency,
    risk_profile: payload.riskProfile,
    updated_at: new Date().toISOString(),
  });
  if (profileError) throw new Error(`Profil: ${profileError.message}`);

  // 2. Créer le portefeuille
  const { data: portfolio, error: portfolioError } = await supabase
    .from('portfolios')
    .insert({
      user_id: user.id,
      name: payload.portfolioName,
      base_currency: payload.baseCurrency,
      description: `${payload.portfolioType} — profil ${payload.riskProfile}`,
    })
    .select('id')
    .single();
  if (portfolioError || !portfolio) throw new Error(`Portefeuille: ${portfolioError?.message}`);

  // 3. Enregistrer le scénario de profil (traçabilité)
  await supabase.from('scenario_runs').insert({
    user_id: user.id,
    portfolio_id: portfolio.id,
    kind: 'allocation_simulation',
    engine_version: '1.0.0',
    inputs: {
      riskProfile: payload.riskProfile,
      portfolioType: payload.portfolioType,
    },
    outputs: payload.scoreResult,
    assumptions: payload.scoreResult.assumptions,
    disclaimers: [
      'Ce profil est calculé à partir de réponses déclaratives.',
      'Il ne constitue pas un conseil en investissement.',
    ],
  });

  return { portfolioId: portfolio.id };
}
