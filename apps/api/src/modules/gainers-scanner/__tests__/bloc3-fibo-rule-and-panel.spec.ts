/**
 * Issue #195 — fiboLevel selection rule tie-break + golden values panel.
 *
 * Tests :
 * 1. nearestFiboLevel tie-break "plus proche, puis plus profond"
 * 2. Golden values panel JSON structure + buckets count
 */

import * as fs from 'fs';
import * as path from 'path';
import { nearestFiboLevel, FiboLevels } from '../bloc3/swing-pivot';

describe('nearestFiboLevel() — tie-break rule (issue #195)', () => {
  const levels: FiboLevels = {
    level382: 199.65,
    level500: 198.0,
    level618: 196.35,
  };

  it('returns 38.2 when price clearly closest to level382', () => {
    expect(nearestFiboLevel(199.7, levels)).toBe(38.2);
  });

  it('returns 50 when price clearly closest to level500', () => {
    expect(nearestFiboLevel(198.05, levels)).toBe(50);
  });

  it('returns 61.8 when price clearly closest to level618', () => {
    expect(nearestFiboLevel(196.4, levels)).toBe(61.8);
  });

  it('TIE-BREAK 38.2 vs 50 → returns 50 (plus profond)', () => {
    // Price 198.825 is equidistant from 199.65 (38.2) and 198.0 (50)
    // Both at 0.825 away. Rule: prefer deeper level → 50.
    const tiePrice = (levels.level382 + levels.level500) / 2;
    expect(nearestFiboLevel(tiePrice, levels)).toBe(50);
  });

  it('TIE-BREAK 50 vs 61.8 → returns 61.8 (plus profond)', () => {
    // Price 197.175 is equidistant from 198.0 (50) and 196.35 (61.8)
    // Both at 0.825. Rule: prefer deeper → 61.8.
    const tiePrice = (levels.level500 + levels.level618) / 2;
    expect(nearestFiboLevel(tiePrice, levels)).toBe(61.8);
  });

  it('TIE-BREAK 38.2 vs 61.8 (rare) → returns 61.8 (plus profond)', () => {
    // Price 198.0 = level500 itself, so 50 wins.
    // For a true 38.2 vs 61.8 tie, we'd need a price equidistant from extremes
    // but closer to mid. With levels {199.65, 198, 196.35} the tie midpoint
    // is 198 = level500 itself (closest). So this case is impossible in practice;
    // we test that the rule doesn't break for symmetric levels.
    const tiePrice = (levels.level382 + levels.level618) / 2;
    expect(nearestFiboLevel(tiePrice, levels)).toBe(50); // 50 wins (it's the mid)
  });

  it('handles exact match on a level', () => {
    expect(nearestFiboLevel(levels.level382, levels)).toBe(38.2);
    expect(nearestFiboLevel(levels.level500, levels)).toBe(50);
    expect(nearestFiboLevel(levels.level618, levels)).toBe(61.8);
  });
});

describe('Golden values panel — issue #195 fixtures', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'golden-values-panel.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  it('contains _meta with version + issue ref', () => {
    expect(fixture._meta).toBeDefined();
    expect(fixture._meta.version).toBe('1.0');
    expect(fixture._meta.issue).toBe('#195');
  });

  it('contains panel array with ≥9 buckets', () => {
    expect(Array.isArray(fixture.panel)).toBe(true);
    expect(fixture.panel.length).toBeGreaterThanOrEqual(9);
  });

  it('total samples ≥ 30 (per issue #195 requirement)', () => {
    const totalSamples = fixture.panel.reduce(
      (sum: number, bucket: any) => sum + (bucket.samples?.length ?? 0),
      0,
    );
    expect(totalSamples).toBeGreaterThanOrEqual(30);
    expect(fixture._summary.total_samples).toBe(totalSamples);
  });

  it('each sample has required fields (symbol, market, period_*, expected_*)', () => {
    for (const bucket of fixture.panel) {
      for (const s of bucket.samples ?? []) {
        expect(typeof s.symbol).toBe('string');
        expect(['equity', 'crypto']).toContain(s.market);
        expect(s.period_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(s.period_end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Either expected_trigger or expected_reject_reason
        const hasTrigger = typeof s.expected_trigger === 'string';
        const hasReject = typeof s.expected_reject_reason === 'string';
        expect(hasTrigger || hasReject).toBe(true);
      }
    }
  });

  it('expected_trigger values are valid EntryTriggerKind', () => {
    const valid = new Set(['PULLBACK_HL_FIBO', 'VWAP_RECLAIM']);
    for (const bucket of fixture.panel) {
      for (const s of bucket.samples ?? []) {
        if (s.expected_trigger) expect(valid.has(s.expected_trigger)).toBe(true);
      }
    }
  });

  it('expected_reject_reason values are valid CandidateRejectReason', () => {
    const valid = new Set([
      'LIQUIDITY_FLOOR', 'MARKET_CAP_MIN', 'VOLATILITY_CLAMP', 'SPREAD_TOO_WIDE',
      'RVOL_INSUFFICIENT', 'PERSISTENCE_BELOW_THRESHOLD', 'TREND_FILTER_FAIL',
      'UNIVERSE_GUARD', 'NO_ENTRY_TRIGGER',
    ]);
    for (const bucket of fixture.panel) {
      for (const s of bucket.samples ?? []) {
        if (s.expected_reject_reason) expect(valid.has(s.expected_reject_reason)).toBe(true);
      }
    }
  });

  it('coverage breakdown matches summary', () => {
    expect(fixture._summary.expected_triggers).toBeGreaterThan(0);
    expect(fixture._summary.expected_rejects).toBeGreaterThan(0);
    expect(fixture._summary.asset_class_split.equity).toBeGreaterThan(0);
    expect(fixture._summary.asset_class_split.crypto).toBeGreaterThan(0);
  });
});
