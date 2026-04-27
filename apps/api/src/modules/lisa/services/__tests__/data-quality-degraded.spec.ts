import { computeDataQualityDegraded } from '@smartvest/ai-analyst';

/**
 * PATCH 1 (PR#1 P0) — kill-switch dataQuality.
 *
 * La règle :
 *   degraded = (us10y ∈ fallback ET vix ∈ fallback) OU |fallback| ≥ 3
 *
 * us10y + vix simultanément en fallback = base macro inutilisable
 * (taux + volatilité = piliers de la classification de régime).
 * 3+ feeds en fallback = dégradation systémique du provider.
 */
describe('computeDataQualityDegraded', () => {
  it('returns true when us10y AND vix are both in fallback', () => {
    expect(computeDataQualityDegraded(['us10y', 'vix'])).toBe(true);
  });

  it('returns true when us10y AND vix in fallback even with other lives', () => {
    // Présence d'autres feeds en fallback ne change rien : us10y + vix suffit
    expect(computeDataQualityDegraded(['us10y', 'vix', 'gold'])).toBe(true);
  });

  it('returns true when 3+ feeds are in fallback (without us10y/vix combo)', () => {
    expect(computeDataQualityDegraded(['gold', 'silver', 'brent'])).toBe(true);
  });

  it('returns true when 4 feeds are in fallback', () => {
    expect(computeDataQualityDegraded(['gold', 'silver', 'brent', 'creditHyOas'])).toBe(true);
  });

  it('returns false when only 1 critical feed in fallback (us10y alone)', () => {
    expect(computeDataQualityDegraded(['us10y'])).toBe(false);
  });

  it('returns false when only vix in fallback', () => {
    expect(computeDataQualityDegraded(['vix'])).toBe(false);
  });

  it('returns false when 2 non-critical feeds in fallback', () => {
    expect(computeDataQualityDegraded(['gold', 'silver'])).toBe(false);
  });

  it('returns false when fallback is empty', () => {
    expect(computeDataQualityDegraded([])).toBe(false);
  });

  it('returns true when 3 feeds, one being us10y but not vix', () => {
    // 3+ feeds → degraded indépendamment du contenu
    expect(computeDataQualityDegraded(['us10y', 'gold', 'silver'])).toBe(true);
  });

  it('returns false when only 2 feeds and neither is us10y+vix combo', () => {
    expect(computeDataQualityDegraded(['us10y', 'gold'])).toBe(false);
    expect(computeDataQualityDegraded(['vix', 'silver'])).toBe(false);
  });
});

/**
 * Integration test du guard dans lisa-autopilot.runPortfolioCycleInner :
 * vérifie que `decisionLog.append({ payload.reason: 'data_quality_degraded' })`
 * est appelé et que `lisa.generateProposal` n'est PAS appelé quand
 * `snapshot.dataQuality.degraded === true && !allowDegradedMacro`.
 *
 * TODO (PR séparée) : nécessite un test harness Supabase chain mock complet
 * (.select().eq().in().order().limit().maybeSingle().gte() — 30+ méthodes).
 * Le pattern existant dans funding/transfers.service.spec.ts couvre ~5 méthodes.
 *
 * Pour l'instant, la logique critique (computeDataQualityDegraded ci-dessus) est
 * 100 % testée. Le câblage autopilot est validé manuellement post-deploy via
 * le decision_log : tout cycle skippé doit avoir kind='autopilot_cycle_completed'
 * + payload.reason='data_quality_degraded'.
 */
