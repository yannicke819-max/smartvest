/**
 * P5-LLM — Tests preprocess Zod sur ThesisCategory.
 *
 * Lisa LLM retourne parfois des asset class names dans le champ
 * category (`equity_us_small`, `commodities_metals_precious`,
 * `crypto_bitcoin`...) au lieu des 7 valeurs canoniques. Le preprocess
 * normalise ces alias avant validation enum stricte.
 */
import { ThesisCategory } from '../index';

function parse(v: unknown): { ok: true; data: string } | { ok: false } {
  const r = ThesisCategory.safeParse(v);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false };
}

describe('ThesisCategory preprocess', () => {
  it('accepts canonical values without modification', () => {
    for (const v of [
      'hidden_gem',
      'turnaround',
      'flow_timing',
      'watchlist',
      'contrarian',
      'mean_reversion',
      'event_driven',
    ]) {
      const r = parse(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).toBe(v);
    }
  });

  it("maps 'event-driven' (dash) → 'event_driven'", () => {
    const r = parse('event-driven');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('event_driven');
  });

  it("maps 'eventdriven' (no separator) → 'event_driven'", () => {
    const r = parse('eventdriven');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('event_driven');
  });

  it("maps 'event' (truncated) → 'event_driven'", () => {
    const r = parse('event');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('event_driven');
  });

  it("maps 'catalyst' synonym → 'event_driven'", () => {
    const r = parse('catalyst');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('event_driven');
  });

  it("maps 'mean-reversion' (dash) → 'mean_reversion'", () => {
    expect((parse('mean-reversion') as { ok: true; data: string }).data).toBe('mean_reversion');
  });

  it("maps 'momentum' / 'breakout' / 'flow' → 'flow_timing'", () => {
    expect((parse('momentum') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('breakout') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('flow') as { ok: true; data: string }).data).toBe('flow_timing');
  });

  it("maps 'undervalued' / 'gem' / 'sleeper' → 'hidden_gem'", () => {
    expect((parse('undervalued') as { ok: true; data: string }).data).toBe('hidden_gem');
    expect((parse('gem') as { ok: true; data: string }).data).toBe('hidden_gem');
    expect((parse('sleeper') as { ok: true; data: string }).data).toBe('hidden_gem');
  });

  // ── Asset class names mis dans category par erreur LLM ──
  it("maps 'equity_us_small' (asset class) → 'flow_timing'", () => {
    const r = parse('equity_us_small');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('flow_timing');
  });

  it("maps 'commodities_metals_precious' → 'flow_timing'", () => {
    const r = parse('commodities_metals_precious');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('flow_timing');
  });

  it("maps 'crypto_bitcoin' → 'flow_timing'", () => {
    const r = parse('crypto_bitcoin');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('flow_timing');
  });

  it("maps 'credit_hy' / 'fx_em' / 'govt_bonds_us' → 'flow_timing'", () => {
    expect((parse('credit_hy') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('fx_em') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('bonds_us') as { ok: true; data: string }).data).toBe('flow_timing');
  });

  it('handles uppercase + whitespace', () => {
    const r = parse('  EVENT-DRIVEN  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe('event_driven');
  });

  // P5-LLM ext — Permissive fallback : tout string inconnu → 'flow_timing'
  // (préfère ouvrir le pipeline avec valeur safe vs throw 400 prod).
  it("permissive fallback : 'tail_hedge' / 'capitulation' / 'dry_powder' → 'flow_timing'", () => {
    expect((parse('tail_hedge') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('capitulation') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('dry_powder') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('rotation') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('barbell') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('definitely_not_a_category') as { ok: true; data: string }).data).toBe('flow_timing');
    expect((parse('xyz') as { ok: true; data: string }).data).toBe('flow_timing');
  });

  it('still rejects non-string types', () => {
    expect(parse(42).ok).toBe(false);
    expect(parse(null).ok).toBe(false);
    expect(parse(undefined).ok).toBe(false);
  });
});
