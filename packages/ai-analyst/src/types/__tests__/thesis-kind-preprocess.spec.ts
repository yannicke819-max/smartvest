/**
 * P5-LLM ext — Tests preprocess Zod sur ThesisKind.
 */
import { ThesisKind } from '../index';

function parse(v: unknown): { ok: true; data: string } | { ok: false } {
  const r = ThesisKind.safeParse(v);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false };
}

describe('ThesisKind preprocess', () => {
  it('accepts canonical values without modification', () => {
    for (const v of ['momentum', 'mean_reversion', 'breakout', 'event', 'macro_hedge']) {
      const r = parse(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toBe(v);
    }
  });

  it("maps 'trend' / 'directional' / 'trend_following' → 'momentum'", () => {
    expect((parse('trend') as { ok: true; data: string }).data).toBe('momentum');
    expect((parse('directional') as { ok: true; data: string }).data).toBe('momentum');
    expect((parse('trend_following') as { ok: true; data: string }).data).toBe('momentum');
  });

  it("maps 'reversion' / 'reversal' / 'oversold_bounce' / 'capitulation' → 'mean_reversion'", () => {
    expect((parse('reversion') as { ok: true; data: string }).data).toBe('mean_reversion');
    expect((parse('reversal') as { ok: true; data: string }).data).toBe('mean_reversion');
    expect((parse('oversold_bounce') as { ok: true; data: string }).data).toBe('mean_reversion');
    expect((parse('capitulation') as { ok: true; data: string }).data).toBe('mean_reversion');
    expect((parse('mean-reversion') as { ok: true; data: string }).data).toBe('mean_reversion');
  });

  it("maps 'event_driven' / 'event-driven' / 'catalyst' / 'earnings' → 'event'", () => {
    expect((parse('event_driven') as { ok: true; data: string }).data).toBe('event');
    expect((parse('event-driven') as { ok: true; data: string }).data).toBe('event');
    expect((parse('catalyst') as { ok: true; data: string }).data).toBe('event');
    expect((parse('earnings') as { ok: true; data: string }).data).toBe('event');
    expect((parse('news') as { ok: true; data: string }).data).toBe('event');
  });

  it("maps 'hedge' / 'tail_hedge' / 'safe_haven' / 'defensive' / 'macro' → 'macro_hedge'", () => {
    expect((parse('hedge') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('tail_hedge') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('tail-hedge') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('safe_haven') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('safe-haven') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('defensive') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('macro') as { ok: true; data: string }).data).toBe('macro_hedge');
  });

  it("maps 'break' / 'break_out' / 'range_break' → 'breakout'", () => {
    expect((parse('break') as { ok: true; data: string }).data).toBe('breakout');
    expect((parse('break_out') as { ok: true; data: string }).data).toBe('breakout');
    expect((parse('break-out') as { ok: true; data: string }).data).toBe('breakout');
    expect((parse('range_break') as { ok: true; data: string }).data).toBe('breakout');
  });

  it('handles uppercase + whitespace', () => {
    expect((parse('  HEDGE  ') as { ok: true; data: string }).data).toBe('macro_hedge');
    expect((parse('TREND') as { ok: true; data: string }).data).toBe('momentum');
  });

  it("permissive fallback : unknown string → 'momentum' (default safe)", () => {
    expect((parse('completely_unknown') as { ok: true; data: string }).data).toBe('momentum');
    expect((parse('xyz_random') as { ok: true; data: string }).data).toBe('momentum');
  });

  it('still rejects non-string types', () => {
    expect(parse(42).ok).toBe(false);
    expect(parse(null).ok).toBe(false);
    expect(parse(undefined).ok).toBe(false);
  });
});
