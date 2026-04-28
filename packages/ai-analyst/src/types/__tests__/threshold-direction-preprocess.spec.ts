/**
 * P0 hotfix — Tests preprocess Zod sur thresholdDirection.
 *
 * Claude Opus utilise parfois le vocabulaire mathématique (gte/lte/gt/lt/eq)
 * au lieu du vocabulaire produit (above/below/cross). Le preprocess
 * normalise ces alias avant validation enum stricte.
 */
import { ThesisInvalidation } from '../index';

const baseCondition = {
  description: 'BTC RSI oversold',
  metricType: 'rsi_14',
  thresholdValue: '30',
};

function build(direction: unknown) {
  return ThesisInvalidation.safeParse({
    conditions: [{ ...baseCondition, thresholdDirection: direction }],
    qualitativeConditions: [],
  });
}

describe('ThesisInvalidation thresholdDirection preprocess', () => {
  it('accepts canonical values without modification', () => {
    for (const v of ['above', 'below', 'cross', 'occurs']) {
      const r = build(v);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe(v);
    }
  });

  it('accepts null', () => {
    const r = build(null);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBeNull();
  });

  it("maps 'gte' → 'above'", () => {
    const r = build('gte');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('above');
  });

  it("maps 'gt' → 'above'", () => {
    const r = build('gt');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('above');
  });

  it("maps 'lte' → 'below'", () => {
    const r = build('lte');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('below');
  });

  it("maps 'lt' → 'below'", () => {
    const r = build('lt');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('below');
  });

  it("maps 'eq' → 'cross'", () => {
    const r = build('eq');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('cross');
  });

  it('handles uppercase + whitespace (case insensitive + trim)', () => {
    const r = build('  GTE  ');
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.conditions[0].thresholdDirection).toBe('above');
  });

  it('maps verbose aliases (greater_than, less_than)', () => {
    expect((build('greater_than') as { success: true; data: { conditions: { thresholdDirection: string }[] } }).data.conditions[0].thresholdDirection).toBe('above');
    expect((build('less_than') as { success: true; data: { conditions: { thresholdDirection: string }[] } }).data.conditions[0].thresholdDirection).toBe('below');
    expect((build('greater_than_or_equal') as { success: true; data: { conditions: { thresholdDirection: string }[] } }).data.conditions[0].thresholdDirection).toBe('above');
    expect((build('less_than_or_equal') as { success: true; data: { conditions: { thresholdDirection: string }[] } }).data.conditions[0].thresholdDirection).toBe('below');
  });

  it('rejects truly unknown values (preserves enum strictness)', () => {
    const r = build('approximately');
    expect(r.success).toBe(false);
  });

  it('rejects non-string non-null inputs', () => {
    const r = build(42);
    expect(r.success).toBe(false);
  });
});
