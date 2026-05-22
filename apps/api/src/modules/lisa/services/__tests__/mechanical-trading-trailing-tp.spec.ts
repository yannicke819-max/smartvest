/**
 * Trailing take-profit (anti « sell winners too early » — Shefrin-Statman 1985).
 *
 * Quand le TP est touché, au lieu de fermer sec (cap des gagnants), on laisse
 * courir au-delà du TP et on ne sort que sur un repli de `giveback`% depuis le
 * pic (peak_pre_exit). Garanties testées :
 *   - flag off → close TP classique (closed_target), aucune régression
 *   - flag on + pas de repli → NE ferme PAS (laisse courir)
 *   - flag on + repli ≥ giveback depuis le pic → ferme en closed_target (pas
 *     closed_stop → stats Kelly non corrompues), prix de sortie > entry (gain)
 *   - ne touche jamais stop_loss_price (plancher dur intact)
 *
 * Instanciation via Object.create (DI lourd) + stubs minimaux, comme
 * mechanical-trading-zero-price-guard.spec.ts.
 */

import { MechanicalTradingService } from '../mechanical-trading.service';

interface Svc {
  lisa: { getLivePrice: (s: string) => Promise<{ price: unknown; source: string } | null> };
  logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock; debug: jest.Mock };
  recordMfe: jest.Mock;
  closePosition: jest.Mock;
  checkReactiveSignals: jest.Mock;
  isGainersStrategy: jest.Mock;
  checkStopTarget: (pos: unknown, isHyperActive?: boolean) => Promise<void>;
}

function makeSvc(price: string, isGainers = true): Svc {
  const svc = Object.create(MechanicalTradingService.prototype) as unknown as Svc;
  svc.lisa = { getLivePrice: async () => ({ price, source: 'twelvedata' }) };
  svc.logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  svc.recordMfe = jest.fn(async () => undefined);
  svc.closePosition = jest.fn(async () => undefined);
  svc.checkReactiveSignals = jest.fn(async () => undefined);
  svc.isGainersStrategy = jest.fn(async () => isGainers);
  return svc;
}

// entry 100, stop 98.7 (-1.3%), TP 103.9 (+3.9%)
function makePos(extra: Record<string, unknown> = {}) {
  return {
    id: 'pos-1',
    symbol: '005930.KO',
    direction: 'long',
    entryPrice: '100',
    stopLossPrice: '98.7',
    takeProfitPrice: '103.9',
    assetClass: 'asia_equity',
    ...extra,
  };
}

describe('Trailing take-profit — checkStopTarget', () => {
  const ENV = process.env.GAINERS_TRAILING_TP_ENABLED;
  afterEach(() => {
    if (ENV === undefined) delete process.env.GAINERS_TRAILING_TP_ENABLED;
    else process.env.GAINERS_TRAILING_TP_ENABLED = ENV;
    delete process.env.GAINERS_TRAILING_TP_GIVEBACK_PCT;
  });

  it('flag OFF → close TP classique (closed_target) au franchissement du TP', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'false';
    const svc = makeSvc('104'); // > TP 103.9
    await svc.checkStopTarget(makePos({ peak_pre_exit: 104 }));
    expect(svc.closePosition).toHaveBeenCalledTimes(1);
    expect(svc.closePosition.mock.calls[0][2]).toBe('closed_target');
    expect(String(svc.closePosition.mock.calls[0][3])).toContain('Take-profit atteint');
  });

  it('flag ON + pas de repli (prix au pic) → NE ferme PAS, laisse courir', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    const svc = makeSvc('104'); // au TP, pic = 104 → pas de repli
    await svc.checkStopTarget(makePos({ peak_pre_exit: 104 }));
    expect(svc.closePosition).not.toHaveBeenCalled();
    expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('[TRAILING_TP]'));
  });

  it('flag ON + repli ≥ 1.5% depuis le pic → ferme en closed_target (gain verrouillé)', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    // pic 108, prix 105 → repli 2.78% > 1.5% → sortie. 105 > entry 100 = gain.
    const svc = makeSvc('105');
    await svc.checkStopTarget(makePos({ peak_pre_exit: 108 }));
    expect(svc.closePosition).toHaveBeenCalledTimes(1);
    expect(svc.closePosition.mock.calls[0][1]).toBe('105'); // prix de sortie
    expect(svc.closePosition.mock.calls[0][2]).toBe('closed_target'); // PAS closed_stop
    expect(String(svc.closePosition.mock.calls[0][3])).toContain('Trailing-TP');
  });

  it('flag ON + petit repli < 1.5% depuis le pic → laisse courir', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    // pic 108, prix 107.5 → repli 0.46% < 1.5% → laisse courir
    const svc = makeSvc('107.5');
    await svc.checkStopTarget(makePos({ peak_pre_exit: 108 }));
    expect(svc.closePosition).not.toHaveBeenCalled();
    expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('[TRAILING_TP]'));
  });

  it('giveback configurable via env (0.3%) → repli 0.46% déclenche la sortie', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    process.env.GAINERS_TRAILING_TP_GIVEBACK_PCT = '0.3';
    const svc = makeSvc('107.5'); // pic 108 → repli 0.46% > 0.3% → sortie
    await svc.checkStopTarget(makePos({ peak_pre_exit: 108 }));
    expect(svc.closePosition).toHaveBeenCalledTimes(1);
    expect(svc.closePosition.mock.calls[0][2]).toBe('closed_target');
  });

  it('scope gainers-only : portfolio NON-gainers → close TP classique malgré flag ON', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    const svc = makeSvc('105', false); // isGainersStrategy → false
    await svc.checkStopTarget(makePos({ peak_pre_exit: 108 }));
    expect(svc.closePosition).toHaveBeenCalledTimes(1);
    expect(svc.closePosition.mock.calls[0][2]).toBe('closed_target');
    expect(String(svc.closePosition.mock.calls[0][3])).toContain('Take-profit atteint'); // close classique, pas Trailing-TP
  });

  it('TP non atteint (prix entre stop et TP) → trailing-TP ne s’active pas', async () => {
    process.env.GAINERS_TRAILING_TP_ENABLED = 'true';
    const svc = makeSvc('101'); // entre 98.7 et 103.9
    await svc.checkStopTarget(makePos({ peak_pre_exit: 101 }));
    expect(svc.closePosition).not.toHaveBeenCalled();
    // pas de hit → délègue aux signaux réactifs (trailing classique en-dessous du TP)
    expect(svc.checkReactiveSignals).toHaveBeenCalledTimes(1);
  });
});
