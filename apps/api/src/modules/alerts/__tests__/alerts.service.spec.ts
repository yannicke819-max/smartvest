import { AlertsService } from '../alerts.service';
import { ValuationService } from '../../valuation/valuation.service';
import type { PortfolioValuation } from '../../valuation/valuation.service';

function makeValuation(overrides: Partial<PortfolioValuation> = {}): PortfolioValuation {
  return {
    portfolioId: 'p1',
    currency: 'EUR',
    totalMarketValue: '10000.00',
    totalCostBasis: '9000.00',
    pnlAbsolute: '1000.00',
    pnlPercent: '11.1111',
    positionCount: 2,
    valuedAt: new Date().toISOString(),
    positions: [],
    ...overrides,
  };
}

function makeValuationService(valuation: PortfolioValuation): ValuationService {
  return { getPortfolioValuation: jest.fn().mockResolvedValue(valuation) } as unknown as ValuationService;
}

describe('AlertsService', () => {
  it('returns no alerts for empty positions', async () => {
    const svc = new AlertsService(makeValuationService(makeValuation({ positions: [] })));
    const alerts = await svc.getAlerts('p1');
    expect(alerts).toHaveLength(0);
  });

  it('raises missing_quote for position without currentPrice', async () => {
    const val = makeValuation({
      positions: [
        {
          positionId: 'x1', assetId: 'a1', ticker: 'AAPL', assetClass: 'equity',
          quantity: '10', averageCost: '150.00', costCurrency: 'USD',
          currentPrice: null, priceCurrency: null,
          marketValue: '1500.00', costBasis: '1500.00',
          pnlAbsolute: '0.00', pnlPercent: '0.0000',
          priceAsOf: null, marketState: 'unknown', changePercent: null,
        },
      ],
    });
    const svc = new AlertsService(makeValuationService(val));
    const alerts = await svc.getAlerts('p1');
    expect(alerts.some((a) => a.ruleId === 'missing_quote')).toBe(true);
  });

  it('raises high_concentration for >35% position', async () => {
    const val = makeValuation({
      totalMarketValue: '10000.00',
      positions: [
        {
          positionId: 'x1', assetId: 'a1', ticker: 'AAPL', assetClass: 'equity',
          quantity: '1', averageCost: '4000.00', costCurrency: 'USD',
          currentPrice: '4000.00', priceCurrency: 'USD',
          marketValue: '4000.00', costBasis: '4000.00',
          pnlAbsolute: '0.00', pnlPercent: '0.0000',
          priceAsOf: new Date().toISOString(), marketState: 'open', changePercent: '0',
        },
      ],
    });
    const svc = new AlertsService(makeValuationService(val));
    const alerts = await svc.getAlerts('p1');
    expect(alerts.some((a) => a.ruleId === 'high_concentration')).toBe(true);
  });

  it('raises crypto_overweight when crypto > 20%', async () => {
    const val = makeValuation({
      totalMarketValue: '10000.00',
      positions: [
        {
          positionId: 'x1', assetId: 'a1', ticker: 'BTC', assetClass: 'crypto',
          quantity: '1', averageCost: '2500.00', costCurrency: 'EUR',
          currentPrice: '2500.00', priceCurrency: 'EUR',
          marketValue: '2500.00', costBasis: '2500.00',
          pnlAbsolute: '0.00', pnlPercent: '0.0000',
          priceAsOf: new Date().toISOString(), marketState: 'open', changePercent: '1',
        },
      ],
    });
    const svc = new AlertsService(makeValuationService(val));
    const alerts = await svc.getAlerts('p1');
    expect(alerts.some((a) => a.ruleId === 'crypto_overweight')).toBe(true);
  });

  it('raises large_daily_move for >5% daily change', async () => {
    const val = makeValuation({
      totalMarketValue: '10000.00',
      positions: [
        {
          positionId: 'x1', assetId: 'a1', ticker: 'XYZ', assetClass: 'equity',
          quantity: '10', averageCost: '100.00', costCurrency: 'USD',
          currentPrice: '106.00', priceCurrency: 'USD',
          marketValue: '1060.00', costBasis: '1000.00',
          pnlAbsolute: '60.00', pnlPercent: '6.0000',
          priceAsOf: new Date().toISOString(), marketState: 'open', changePercent: '6.00',
        },
      ],
    });
    const svc = new AlertsService(makeValuationService(val));
    const alerts = await svc.getAlerts('p1');
    expect(alerts.some((a) => a.ruleId === 'large_daily_move')).toBe(true);
  });

  it('orders alerts: critical first', async () => {
    const val = makeValuation({
      totalMarketValue: '10000.00',
      positions: [
        {
          positionId: 'x1', assetId: 'a1', ticker: 'AAPL', assetClass: 'equity',
          quantity: '1', averageCost: '6000.00', costCurrency: 'USD',
          currentPrice: null, priceCurrency: null,
          marketValue: '6000.00', costBasis: '6000.00',
          pnlAbsolute: '0.00', pnlPercent: '0.0000',
          priceAsOf: null, marketState: 'unknown', changePercent: null,
        },
      ],
    });
    const svc = new AlertsService(makeValuationService(val));
    const alerts = await svc.getAlerts('p1');
    if (alerts.length > 1) {
      const severityOrder = ['critical', 'warning', 'info'];
      for (let i = 1; i < alerts.length; i++) {
        const prev = severityOrder.indexOf(alerts[i - 1].severity);
        const curr = severityOrder.indexOf(alerts[i].severity);
        expect(prev).toBeLessThanOrEqual(curr);
      }
    }
  });
});
