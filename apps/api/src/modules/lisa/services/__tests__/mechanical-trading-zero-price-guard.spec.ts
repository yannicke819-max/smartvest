/**
 * ZERO_PRICE_GUARD — régression de l'incident SEE.LSE (14/05/2026, -$1574).
 *
 * Un tick à prix <= 0 (ou NaN) d'une source NON taggée fallback contournait
 * le sanity bound (gardé par `livePx.gt(0)`) dans checkStopTarget et déclenchait
 * un stop à 0 → fausse liquidation -100%. Le garde doit skip tout prix non-positif.
 *
 * On instancie via Object.create (constructor DI lourd) + stubs minimaux.
 */

import { MechanicalTradingService } from '../mechanical-trading.service';

interface Svc {
  lisa: { getLivePrice: (s: string) => Promise<{ price: unknown; source: string } | null> };
  logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock; debug: jest.Mock };
  checkStopTarget: (pos: unknown, isHyperActive?: boolean) => Promise<void>;
}

function makeSvc(price: unknown, source = 'eodhd'): Svc {
  const svc = Object.create(MechanicalTradingService.prototype) as unknown as Svc;
  svc.lisa = { getLivePrice: async () => ({ price, source }) };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return svc;
}

const pos = {
  symbol: 'SEE.LSE',
  direction: 'long',
  entryPrice: '5.0',
  stopLossPrice: '4.89',
  takeProfitPrice: '5.14',
};

describe('ZERO_PRICE_GUARD — checkStopTarget', () => {
  it('prix 0 (source non-fallback) → skip, pas de close destructeur', async () => {
    const svc = makeSvc('0', 'eodhd');
    await expect(svc.checkStopTarget(pos)).resolves.toBeUndefined();
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ZERO_PRICE_GUARD]'));
  });

  it('prix négatif → skip', async () => {
    const svc = makeSvc('-1.0', 'eodhd');
    await expect(svc.checkStopTarget(pos)).resolves.toBeUndefined();
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ZERO_PRICE_GUARD]'));
  });

  it('prix NaN/non-numérique → skip', async () => {
    const svc = makeSvc('abc', 'eodhd');
    await expect(svc.checkStopTarget(pos)).resolves.toBeUndefined();
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[ZERO_PRICE_GUARD]'));
  });

  it('prix valide entre stop et TP → NE déclenche PAS le zero-guard (pas de faux positif)', async () => {
    const svc = makeSvc('5.0', 'eodhd'); // ni <=4.89 ni >=5.14 → aucun hit, retour propre
    await expect(svc.checkStopTarget(pos)).resolves.toBeUndefined();
    const zeroGuardCalls = svc.logger.warn.mock.calls.filter((c) =>
      String(c[0]).includes('[ZERO_PRICE_GUARD]'),
    );
    expect(zeroGuardCalls).toHaveLength(0);
  });
});
