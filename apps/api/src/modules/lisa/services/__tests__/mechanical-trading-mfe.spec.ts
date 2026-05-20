/**
 * PR #369 — Tests instrumentation MFE (recordMfe).
 *
 * recordMfe(positionId, price, isLong) doit faire un UPDATE conditionnel
 * lisa_positions.peak_pre_exit avec le bon filtre OR :
 *   - long  : peak_pre_exit IS NULL OR peak_pre_exit < price (on garde le max)
 *   - short : peak_pre_exit IS NULL OR peak_pre_exit > price (on garde le min)
 *
 * On instancie via Object.create pour éviter le constructor lourd (DI).
 */

import { MechanicalTradingService } from '../mechanical-trading.service';

interface Captured {
  updatePayload?: Record<string, unknown>;
  eqArgs?: [string, unknown];
  orArg?: string;
}

function makeServiceWithCapture(): { svc: MechanicalTradingService; cap: Captured } {
  const cap: Captured = {};
  const chain = {
    update(payload: Record<string, unknown>) {
      cap.updatePayload = payload;
      return this;
    },
    eq(col: string, val: unknown) {
      cap.eqArgs = [col, val];
      return this;
    },
    or(arg: string) {
      cap.orArg = arg;
      return Promise.resolve({ error: null });
    },
  };
  const supabase = {
    getClient: () => ({ from: () => chain }),
  };
  const svc = Object.create(MechanicalTradingService.prototype) as MechanicalTradingService;
  (svc as unknown as { supabase: unknown }).supabase = supabase;
  return { svc, cap };
}

describe('PR #369 — recordMfe', () => {
  it('long : update peak_pre_exit + filtre OR null/lt', async () => {
    const { svc, cap } = makeServiceWithCapture();
    await (svc as unknown as { recordMfe: (id: string, p: number, l: boolean) => Promise<void> })
      .recordMfe('pos-1', 181.5, true);
    expect(cap.updatePayload).toEqual({ peak_pre_exit: 181.5 });
    expect(cap.eqArgs).toEqual(['id', 'pos-1']);
    expect(cap.orArg).toBe('peak_pre_exit.is.null,peak_pre_exit.lt.181.5');
  });

  it('short : filtre OR null/gt (on garde le min)', async () => {
    const { svc, cap } = makeServiceWithCapture();
    await (svc as unknown as { recordMfe: (id: string, p: number, l: boolean) => Promise<void> })
      .recordMfe('pos-2', 50, false);
    expect(cap.orArg).toBe('peak_pre_exit.is.null,peak_pre_exit.gt.50');
  });

  it('prix invalide (<=0 ou NaN) → no-op (pas d\'update)', async () => {
    const { svc, cap } = makeServiceWithCapture();
    await (svc as unknown as { recordMfe: (id: string, p: number, l: boolean) => Promise<void> })
      .recordMfe('pos-3', 0, true);
    expect(cap.updatePayload).toBeUndefined();
    await (svc as unknown as { recordMfe: (id: string, p: number, l: boolean) => Promise<void> })
      .recordMfe('pos-3', Number.NaN, true);
    expect(cap.updatePayload).toBeUndefined();
  });

  it('erreur supabase avalée (fire-and-forget, ne throw pas)', async () => {
    const svc = Object.create(MechanicalTradingService.prototype) as MechanicalTradingService;
    (svc as unknown as { supabase: unknown }).supabase = {
      getClient: () => {
        throw new Error('boom');
      },
    };
    await expect(
      (svc as unknown as { recordMfe: (id: string, p: number, l: boolean) => Promise<void> })
        .recordMfe('pos-4', 100, true),
    ).resolves.toBeUndefined();
  });
});
