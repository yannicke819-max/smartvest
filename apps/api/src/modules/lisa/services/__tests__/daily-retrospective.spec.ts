import {
  buildDailyRetrospectiveUserPrompt,
  parseDailyRetrospective,
  type DailyStatsInput,
} from '../daily-retrospective.helper';

const sampleStats: DailyStatsInput = {
  date: '2026-05-24',
  portfolioId: 'abc-123',
  capitalUsd: 10500,
  n_opens: 5,
  n_closes: 4,
  n_winners: 0,
  n_losers: 4,
  sum_pnl_usd: -49.68,
  pnl_pct_of_capital: -0.0047,
  top_winner: undefined,
  top_loser: { symbol: 'ETHUSDT', pnl_usd: -14.57, pnl_pct: -1.85 },
  rm_close_now: 0,
  rm_tighten_sl: 0,
  rm_raise_tp: 0,
  rm_momentum_ride: 0,
  cg_rejections: 0,
  cs_skipped: 0,
  cs_low_mult: 0,
  cs_std: 5,
  cs_high_mult: 0,
  cascades_avoided: 0,
};

describe('buildDailyRetrospectiveUserPrompt', () => {
  it('inclut date, PnL, opens, closes', () => {
    const p = buildDailyRetrospectiveUserPrompt(sampleStats);
    expect(p).toContain('2026-05-24');
    expect(p).toContain('Capital portfolio : $10500');
    expect(p).toContain('Opens : 5');
    expect(p).toContain('Closes : 4');
    expect(p).toContain('0W / 4L');
    expect(p).toContain('-$49.68');
  });

  it('inclut top_loser quand présent', () => {
    const p = buildDailyRetrospectiveUserPrompt(sampleStats);
    expect(p).toContain('ETHUSDT');
    expect(p).toContain('Top loser');
  });

  it('omet top_winner quand undefined', () => {
    const p = buildDailyRetrospectiveUserPrompt(sampleStats);
    expect(p).not.toContain('Top winner');
  });

  it('mentionne "Aucune action proactive" quand risk-monitor inactif', () => {
    const p = buildDailyRetrospectiveUserPrompt(sampleStats);
    expect(p).toContain('Aucune action proactive');
  });

  it('détaille les actions risk-monitor quand actives', () => {
    const p = buildDailyRetrospectiveUserPrompt({
      ...sampleStats,
      rm_tighten_sl: 3,
      rm_close_now: 1,
      rm_raise_tp: 2,
    });
    expect(p).toContain('TIGHTEN_SL: 3');
    expect(p).toContain('CLOSE_NOW: 1');
    expect(p).toContain('RAISE_TP: 2');
  });

  it('inclut événements notables', () => {
    const p = buildDailyRetrospectiveUserPrompt({
      ...sampleStats,
      notable_events: ['kill_switch_triggered', 'budget_pause'],
    });
    expect(p).toContain('Événements notables');
    expect(p).toContain('kill_switch_triggered');
    expect(p).toContain('budget_pause');
  });

  it('inclut distribution conviction sizing', () => {
    const p = buildDailyRetrospectiveUserPrompt({
      ...sampleStats,
      cs_skipped: 2,
      cs_low_mult: 1,
      cs_std: 3,
      cs_high_mult: 1,
    });
    expect(p).toContain('2 skipped / 1 ×0.7 / 3 ×1.0 / 1 ×1.5');
  });
});

describe('parseDailyRetrospective', () => {
  it('parse JSON valide', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'Journée difficile : 4 SL en cascade sur les cryptos. Le pump initial s\'est éteint sans catalyseur.',
      sentiment: 'negatif',
      suggestions: ['Activer correlation_guard', 'Tighten cooldown crypto à 90min'],
    }));
    expect(r).not.toBeNull();
    expect(r!.narrative).toContain('Journée difficile');
    expect(r!.sentiment).toBe('negatif');
    expect(r!.suggestions).toHaveLength(2);
  });

  it('extrait JSON depuis texte avec markdown', () => {
    const content = '```json\n{"narrative": "Test", "sentiment": "neutre", "suggestions": []}\n```\nExplications...';
    const r = parseDailyRetrospective(content);
    expect(r).not.toBeNull();
    expect(r!.narrative).toBe('Test');
  });

  it('sentiment invalide → fallback neutre', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'OK', sentiment: 'unknown_sentiment', suggestions: [],
    }));
    expect(r!.sentiment).toBe('neutre');
  });

  it('suggestions cap à 3', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'OK', sentiment: 'neutre',
      suggestions: ['1', '2', '3', '4', '5'],
    }));
    expect(r!.suggestions).toHaveLength(3);
  });

  it('suggestion non-string filtrée', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'OK', sentiment: 'neutre',
      suggestions: ['valid', 123, null, 'autre'],
    }));
    expect(r!.suggestions).toEqual(['valid', 'autre']);
  });

  it('narrative tronquée à 2000 chars', () => {
    const long = 'A'.repeat(3000);
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: long, sentiment: 'neutre', suggestions: [],
    }));
    expect(r!.narrative.length).toBe(2000);
  });

  it('suggestion tronquée à 280 chars chacune', () => {
    const long = 'A'.repeat(500);
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'OK', sentiment: 'neutre', suggestions: [long],
    }));
    expect(r!.suggestions[0].length).toBe(280);
  });

  it('null si narrative absente', () => {
    expect(parseDailyRetrospective(JSON.stringify({
      sentiment: 'neutre', suggestions: [],
    }))).toBeNull();
  });

  it('null si content vide', () => {
    expect(parseDailyRetrospective('')).toBeNull();
    expect(parseDailyRetrospective('   ')).toBeNull();
  });

  it('null si JSON invalide', () => {
    expect(parseDailyRetrospective('not json at all')).toBeNull();
    expect(parseDailyRetrospective('{"narrative": "incomplete')).toBeNull();
  });

  it('parse JSON avec strings contenant des braces (anti-regex naïf)', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'On a vu une cascade {SL} sur 4 cryptos.',
      sentiment: 'negatif',
      suggestions: ['Ajuster {threshold}'],
    }));
    expect(r).not.toBeNull();
    expect(r!.narrative).toContain('{SL}');
    expect(r!.suggestions[0]).toBe('Ajuster {threshold}');
  });

  it('suggestions absentes → array vide ok', () => {
    const r = parseDailyRetrospective(JSON.stringify({
      narrative: 'OK', sentiment: 'positif',
    }));
    expect(r!.suggestions).toEqual([]);
  });
});
