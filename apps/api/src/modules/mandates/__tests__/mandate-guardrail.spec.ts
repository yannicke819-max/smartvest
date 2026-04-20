import { BadRequestException } from '@nestjs/common';
import { MandateGuardrailService } from '../services/mandate-guardrail.service';

const VALID_BASE = {
  portfolioId: '00000000-0000-0000-0000-000000000001',
  label: 'Mandat test',
  maxPositionSizePct: 20,
  maxSingleTradePct: 10,
  maxDailyTradePct: 15,
  requiresHumanAbovePct: 5,
  stopLossTriggerPct: 10,
  allowedAssetClasses: ['equity', 'etf'],
  forbiddenTickers: [],
  expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
};

describe('MandateGuardrailService', () => {
  const svc = new MandateGuardrailService();

  it('accepts a fully valid mandate', () => {
    expect(() => svc.validateCreate(VALID_BASE)).not.toThrow();
  });

  it('rejects maxPositionSizePct > 50', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, maxPositionSizePct: 55, maxSingleTradePct: 5 }),
    ).toThrow(BadRequestException);
  });

  it('rejects maxSingleTradePct > maxPositionSizePct', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, maxPositionSizePct: 20, maxSingleTradePct: 25 }),
    ).toThrow(BadRequestException);
  });

  it('rejects maxDailyTradePct > 30', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, maxDailyTradePct: 35 }),
    ).toThrow(BadRequestException);
  });

  it('rejects stopLossTriggerPct > 25', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, stopLossTriggerPct: 30 }),
    ).toThrow(BadRequestException);
  });

  it('rejects expiresAt in the past', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, expiresAt: '2020-01-01T00:00:00.000Z' }),
    ).toThrow(BadRequestException);
  });

  it('rejects expiresAt more than 1 year ahead', () => {
    const far = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, expiresAt: far }),
    ).toThrow(BadRequestException);
  });

  it('rejects empty allowedAssetClasses', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, allowedAssetClasses: [] }),
    ).toThrow(BadRequestException);
  });

  it('rejects invalid portfolioId (not UUID)', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, portfolioId: 'not-a-uuid' }),
    ).toThrow(BadRequestException);
  });

  it('rejects label shorter than 3 characters', () => {
    expect(() =>
      svc.validateCreate({ ...VALID_BASE, label: 'AB' }),
    ).toThrow(BadRequestException);
  });

  it('validateUpdate: allows partial updates', () => {
    const result = svc.validateUpdate({ label: 'Nouveau label' });
    expect(result.label).toBe('Nouveau label');
  });

  it('validateUpdate: rejects cross-field violation', () => {
    expect(() =>
      svc.validateUpdate({ maxPositionSizePct: 10, maxSingleTradePct: 15 }),
    ).toThrow(BadRequestException);
  });
});
