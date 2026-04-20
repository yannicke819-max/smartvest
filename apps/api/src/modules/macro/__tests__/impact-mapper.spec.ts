import { ImpactMapperService } from '../services/impact-mapper.service';

describe('ImpactMapperService', () => {
  const svc = new ImpactMapperService();

  it('maps sector exposures for central_bank_decision', () => {
    const sectors = svc.mapSectorExposures('central_bank_decision', 'warning', 'medium');
    expect(sectors.length).toBeGreaterThan(0);
    const financials = sectors.find((s) => s.sector === 'financials');
    expect(financials).toBeDefined();
    expect(financials!.direction).toBe('positive');
  });

  it('maps negative direction for real_estate under rate hike', () => {
    const sectors = svc.mapSectorExposures('central_bank_decision', 'warning', 'medium');
    const re = sectors.find((s) => s.sector === 'real_estate');
    expect(re?.direction).toBe('negative');
  });

  it('scales magnitude by confidence level', () => {
    const sectorsLow = svc.mapSectorExposures('central_bank_decision', 'critical', 'low');
    const sectorsHigh = svc.mapSectorExposures('central_bank_decision', 'critical', 'high');
    const low = parseFloat(sectorsLow[0].magnitudePct ?? '0');
    const high = parseFloat(sectorsHigh[0].magnitudePct ?? '0');
    expect(high).toBeGreaterThan(low);
  });

  it('returns empty exposures for unknown asset classes in portfolio', () => {
    const result = svc.mapAssetExposures('central_bank_decision', [
      { assetId: 'a1', ticker: 'XYZ', isin: null, assetClass: 'unknown_class' },
    ], 'warning', 'medium');
    expect(result).toHaveLength(0);
  });

  it('maps equity direction as negative for central_bank_decision', () => {
    const result = svc.mapAssetExposures('central_bank_decision', [
      { assetId: 'a1', ticker: 'SPY', isin: 'US78462F1030', assetClass: 'equity' },
    ], 'warning', 'medium');
    expect(result).toHaveLength(1);
    expect(result[0].direction).toBe('negative');
  });

  it('maps geopolitical commodity exposure as positive', () => {
    const result = svc.mapAssetExposures('geopolitical_tension', [
      { assetId: 'a2', ticker: 'GLD', isin: null, assetClass: 'gold' },
    ], 'critical', 'high');
    expect(result[0].direction).toBe('positive');
  });
});
