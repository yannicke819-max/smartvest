import { buildOversoldLessons, type OversoldCloseRow } from '../oversold-retrospective.helper';

function row(p: Partial<OversoldCloseRow>): OversoldCloseRow {
  return {
    pnlPct: p.pnlPct ?? 1.5,
    pnlUsd: p.pnlUsd ?? 100,
    deadlineVerdict: p.deadlineVerdict ?? 'NEUTRAL',
    pnlIfHeldToDeadlinePct: p.pnlIfHeldToDeadlinePct ?? 1.5,
    bestDayLabel: p.bestDayLabel ?? 'J+10',
    bestDayPnlPct: p.bestDayPnlPct ?? 1.5,
  };
}

const OPTS = { region: 'US', scope: 'oversold_us_equity', minSample: 5 };

describe('buildOversoldLessons — générateur déterministe', () => {
  it('renvoie [] sous le sample minimum (anti-bruit)', () => {
    const rows = [row({}), row({}), row({})]; // n=3 < 5
    expect(buildOversoldLessons(rows, OPTS)).toEqual([]);
  });

  it('held_better dominant + give-up positif → EXIT_TIMING_HOLD_LONGER', () => {
    // 6 closes : sortis à +1.5%, mais tenir à J+10 aurait fait +4% → held_better.
    const rows = Array.from({ length: 6 }, () =>
      row({ pnlPct: 1.5, pnlIfHeldToDeadlinePct: 4, deadlineVerdict: 'HELD_BETTER', bestDayLabel: 'J+6', bestDayPnlPct: 4.2 }),
    );
    const out = buildOversoldLessons(rows, OPTS);
    const kinds = out.map((l) => l.lessonKind);
    expect(kinds).toContain('EXIT_TIMING_HOLD_LONGER');
    expect(kinds).toContain('HEALTH_SUMMARY');
    const exit = out.find((l) => l.lessonKind === 'EXIT_TIMING_HOLD_LONGER')!;
    expect(exit.scope).toBe('oversold_us_equity');
    expect(exit.sampleSize).toBe(6);
    expect(exit.lessonText).toContain('J+6'); // meilleur jour le plus fréquent
    expect(exit.confidence).toBeGreaterThanOrEqual(0.5);
    expect(exit.confidence).toBeLessThan(0.95); // jamais auto-appliquable
  });

  it('close_better dominant + give-up négatif → EXIT_TIMING_LOCK_OK', () => {
    // Tenir aurait dégradé (held = -1% vs close +1.5%).
    const rows = Array.from({ length: 8 }, () =>
      row({ pnlPct: 1.5, pnlIfHeldToDeadlinePct: -1, deadlineVerdict: 'CLOSE_BETTER', bestDayLabel: 'J+1', bestDayPnlPct: 1.8 }),
    );
    const out = buildOversoldLessons(rows, OPTS);
    expect(out.map((l) => l.lessonKind)).toContain('EXIT_TIMING_LOCK_OK');
  });

  it('aucune majorité de verdict → EXIT_TIMING_MIXED (confiance plafonnée)', () => {
    // 2 held / 1 close / 3 neutral : ni held ni close ≥ 50% → mitigé.
    const rows = [
      ...Array.from({ length: 2 }, () => row({ deadlineVerdict: 'HELD_BETTER', pnlIfHeldToDeadlinePct: 3, pnlPct: 1.5 })),
      row({ deadlineVerdict: 'CLOSE_BETTER', pnlIfHeldToDeadlinePct: 0, pnlPct: 1.5 }),
      ...Array.from({ length: 3 }, () => row({ deadlineVerdict: 'NEUTRAL', pnlIfHeldToDeadlinePct: 1.6, pnlPct: 1.5 })),
    ];
    const out = buildOversoldLessons(rows, OPTS);
    const mixed = out.find((l) => l.lessonKind === 'EXIT_TIMING_MIXED');
    expect(mixed).toBeDefined();
    expect(mixed!.confidence).toBeLessThanOrEqual(0.6);
  });

  it('HEALTH_SUMMARY remonte win rate + scope correct', () => {
    const rows = [
      ...Array.from({ length: 4 }, () => row({ pnlPct: 2, pnlUsd: 150 })), // wins
      ...Array.from({ length: 2 }, () => row({ pnlPct: -3, pnlUsd: -200 })), // losses
    ];
    const out = buildOversoldLessons(rows, { region: 'EU', scope: 'oversold_eu_equity', minSample: 5 });
    const health = out.find((l) => l.lessonKind === 'HEALTH_SUMMARY')!;
    expect(health.scope).toBe('oversold_eu_equity');
    expect(health.winRateObserved).toBeCloseTo((4 / 6) * 100, 1);
    expect(health.lessonText).toContain('Oversold EU');
  });
});
