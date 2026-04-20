import { scoreRiskProfile } from '../risk-profile-scorer';
import type { OnboardingAnswers } from '@smartvest/shared-types';

const BASE: OnboardingAnswers = {
  baseCurrency: 'EUR',
  horizon: 'more_10y',
  tolerance: 'up_50pct',
  experience: 'moderate',
  liquidityNeed: 'low',
  goal: 'strong_growth',
};

describe('scoreRiskProfile', () => {
  test('profil offensif : horizon long + tolérance haute + objectif croissance forte', () => {
    const result = scoreRiskProfile({ ...BASE });
    expect(result.profile).toBe('offensif');
    expect(result.totalScore).toBeGreaterThanOrEqual(20);
    expect(result.dimensions).toHaveLength(5);
  });

  test('profil prudent : horizon court + tolérance zéro + préservation du capital', () => {
    const result = scoreRiskProfile({
      ...BASE,
      horizon: 'less_1y',
      tolerance: 'no_loss',
      experience: 'none',
      liquidityNeed: 'high',
      goal: 'capital_preservation',
    });
    expect(result.profile).toBe('prudent');
    expect(result.totalScore).toBeLessThanOrEqual(9);
  });

  test('profil équilibré : paramètres médians', () => {
    const result = scoreRiskProfile({
      ...BASE,
      horizon: '3_5y',
      tolerance: 'up_25pct',
      experience: 'basic',
      liquidityNeed: 'medium',
      goal: 'moderate_growth',
    });
    expect(result.profile).toBe('equilibre');
  });

  test('profil dynamique : horizon 5-10 ans + tolérance modérée-haute', () => {
    const result = scoreRiskProfile({
      ...BASE,
      horizon: '5_10y',
      tolerance: 'up_25pct',
      experience: 'moderate',
      liquidityNeed: 'low',
      goal: 'strong_growth',
    });
    expect(['dynamique', 'equilibre']).toContain(result.profile);
  });

  test('résultat contient toujours les hypothèses et disclaimers', () => {
    const result = scoreRiskProfile(BASE);
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.description).toBeTruthy();
    expect(result.label).toBeTruthy();
  });

  test('score normalisé entre 1 et 25', () => {
    const result = scoreRiskProfile(BASE);
    expect(result.totalScore).toBeGreaterThanOrEqual(1);
    expect(result.totalScore).toBeLessThanOrEqual(25);
  });

  test('le score est déterministe pour les mêmes entrées', () => {
    const r1 = scoreRiskProfile(BASE);
    const r2 = scoreRiskProfile(BASE);
    expect(r1.totalScore).toBe(r2.totalScore);
    expect(r1.profile).toBe(r2.profile);
  });
});
