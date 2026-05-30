// Issue #502 — tests unitaires post-filter contradictions coach.

import { applyCoachConflictPostFilter, ENTRY_LOOSENING_PARAMS } from '../strategy-coach.service';

describe('applyCoachConflictPostFilter', () => {
  it('drop la lesson ACTIVATE_TRADING_BOT quand autopilot déjà actif', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [
        { lesson_kind: 'ACTIVATE_TRADING_BOT', lesson_text: 'Activer le bot' },
        { lesson_kind: 'PULLBACK_WAIT', lesson_text: 'attendre retracement' },
      ],
      params: [],
      autopilotEnabled: true,
      hasHighConfEntryLessons: false,
    });

    expect(res.lessons).toHaveLength(1);
    expect((res.lessons[0] as { lesson_kind: string }).lesson_kind).toBe('PULLBACK_WAIT');
    expect(res.dropped).toEqual([
      { type: 'lesson', name: 'ACTIVATE_TRADING_BOT', reason: 'autopilot_already_enabled' },
    ]);
  });

  it('garde la lesson ACTIVATE_TRADING_BOT quand autopilot OFF (cas légitime)', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [{ lesson_kind: 'ACTIVATE_TRADING_BOT', lesson_text: 'Activer le bot' }],
      params: [],
      autopilotEnabled: false,
      hasHighConfEntryLessons: false,
    });
    expect(res.lessons).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });

  it('drop param trading_bot_enabled false→true quand autopilot déjà actif', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'trading_bot_enabled', current: false, proposed: true }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: false,
    });
    expect(res.params).toHaveLength(0);
    expect(res.dropped[0]).toMatchObject({ type: 'param', name: 'trading_bot_enabled', reason: 'autopilot_already_enabled' });
  });

  it('drop entry_threshold_factor abaissé quand lesson entry_discipline conf ≥ 0.85 active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'entry_threshold_factor', current: 1.5, proposed: 1.2 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(0);
    expect(res.dropped[0]).toMatchObject({ name: 'entry_threshold_factor', reason: 'conflicts_with_high_conf_entry_discipline_lesson' });
  });

  it('drop min_confidence_to_trade abaissé quand lesson entry_discipline active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'min_confidence_to_trade', current: 0.8, proposed: 0.6 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(0);
  });

  it('drop max_change_pct relevé (assouplit) quand lesson entry_discipline active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'gainers_max_change_pct_long', current: 10, proposed: 15 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(0);
  });

  it('GARDE entry_threshold_factor RELEVÉ (durcit) même avec lesson active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'entry_threshold_factor', current: 1.5, proposed: 1.8 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    // Durcir (1.5 → 1.8) ne contredit pas la lesson de prudence → laisser passer
    expect(res.params).toHaveLength(1);
    expect(res.dropped).toHaveLength(0);
  });

  it('GARDE max_change_pct ABAISSÉ (durcit) même avec lesson active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'max_change_pct', current: 10, proposed: 8 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(1);
  });

  it('GARDE param non listé même avec lesson active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'autopilot_cycle_minutes', current: 5, proposed: 10 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(1);
  });

  it('case du nom de param insensible', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'MIN_CONFIDENCE_TO_TRADE', current: 0.8, proposed: 0.6 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });
    expect(res.params).toHaveLength(0);
  });

  it('GARDE l\'assouplissement quand aucune lesson entry_discipline high-conf active', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [],
      params: [{ param: 'entry_threshold_factor', current: 1.5, proposed: 1.2 }],
      autopilotEnabled: true,
      hasHighConfEntryLessons: false,
    });
    // Sans garde-fou lesson actif, le coach garde le droit de proposer un assouplissement
    expect(res.params).toHaveLength(1);
  });

  it('ENTRY_LOOSENING_PARAMS contient les params connus pour assouplir l\'entrée', () => {
    expect(ENTRY_LOOSENING_PARAMS.min_confidence_to_trade).toBe('decrease');
    expect(ENTRY_LOOSENING_PARAMS.entry_threshold_factor).toBe('decrease');
    expect(ENTRY_LOOSENING_PARAMS.gainers_max_change_pct_long).toBe('increase');
  });

  it('cas combiné observé prod 30/05 — lesson activate + param trading_bot + entry threshold assoupli', () => {
    const res = applyCoachConflictPostFilter({
      lessons: [
        { lesson_kind: 'ACTIVATE_TRADING_BOT', lesson_text: 'Activer le bot' },
        { lesson_kind: 'INCREASE_MAX_RISK_PER_TRADE_PERCENT', lesson_text: 'augmenter risque' },
      ],
      params: [
        { param: 'trading_bot_enabled', current: false, proposed: true },
        { param: 'entry_threshold_factor', current: 1.5, proposed: 1.2 },
      ],
      autopilotEnabled: true,
      hasHighConfEntryLessons: true,
    });

    expect(res.lessons).toHaveLength(1);
    expect((res.lessons[0] as { lesson_kind: string }).lesson_kind).toBe('INCREASE_MAX_RISK_PER_TRADE_PERCENT');
    expect(res.params).toHaveLength(0);
    expect(res.dropped).toHaveLength(3);
    expect(res.dropped.map((d) => d.name).sort()).toEqual(
      ['ACTIVATE_TRADING_BOT', 'entry_threshold_factor', 'trading_bot_enabled'].sort(),
    );
  });
});
