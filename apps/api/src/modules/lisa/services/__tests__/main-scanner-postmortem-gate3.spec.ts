/**
 * Tests Gate 3 du parser MainScannerPostMortemService — rejette les lessons
 * actionables qui n'ont pas de target_path valide dans le whitelist.
 *
 * Pattern in-test (cf. lesson-auto-apply-key-parser.spec.ts) — reproduit le
 * sets ACTIONABLE_LESSON_KINDS + VALID_TARGET_PATHS + la logique Gate 3. Si
 * refactor côté service, garder aligné.
 *
 * Fix 02/06/2026 — sans Gate 3, le générateur Gemini produit des lessons
 * 'gate_calibration' / 'losing_pattern' / etc. avec proposed_config_change vide
 * ou target_path non whitelisté → 162 lessons orphelines observées en prod.
 */

describe('MainScannerPostMortemService — Gate 3 (mandatory actionable target_path)', () => {
  // Repro from main-scanner-postmortem.service.ts — keep aligned
  const ACTIONABLE_LESSON_KINDS: ReadonlySet<string> = new Set<string>([
    'gate_calibration',
    'session_filter',
    'sizing_rule',
    'exit_rule',
    'losing_pattern',
    'winning_pattern',
    'entry_discipline',
  ]);

  const VALID_TARGET_PATHS: ReadonlySet<string> = new Set<string>([
    'gainers_default_sl_pct',
    'gainers_default_tp_pct',
    'gainers_min_persistence_score',
    'gainers_min_path_efficiency',
    'gainers_max_change_pct',
    'gainers_min_change_pct',
    'gainers_fees_aware_buffer',
    'gainers_position_pct',
    'gainers_cycle_minutes',
    'gainers_persistence_top_n',
    'news_shock_close_max_age_minutes_lse',
    'news_shock_close_sentiment_threshold_lse',
    'GAINERS_TRAILING_STOP_BREAKEVEN_ENABLED',
    'GAINERS_MIN_PATH_EFFICIENCY_US',
    'GAINERS_MIN_PATH_EFFICIENCY_EU',
    'GAINERS_MIN_PATH_EFFICIENCY_ASIA',
    'GAINERS_HOUR_BLACKLIST_US_UTC',
    'GAINERS_HOUR_BLACKLIST_EU_UTC',
    'GAINERS_HOUR_BLACKLIST_ASIA_UTC',
    'GAINERS_POST_SL_COOLDOWN_MIN',
    'GAINERS_EARNINGS_FILTER_DAYS',
    'GAINERS_MAX_CHANGE_PCT_LONG',
    'GAINERS_MAX_CHANGE_PCT_LONG_US_LARGE',
    'GAINERS_MAX_CHANGE_PCT_LONG_EU',
    'GAINERS_MAX_CHANGE_PCT_LONG_ASIA',
  ]);

  const META_KEYS = new Set(['note', 'comment', 'reason', 'table', 'portfolio_id_only']);

  function passesGate3(lesson: { lesson_kind: string; proposed_config_change?: Record<string, unknown> | null }): boolean {
    if (!ACTIONABLE_LESSON_KINDS.has(lesson.lesson_kind)) return true; // observational pass-through
    const cc = lesson.proposed_config_change;
    if (!cc || typeof cc !== 'object') return false;
    const validTargets = Object.keys(cc).filter(
      (k) => !META_KEYS.has(k.toLowerCase()) && VALID_TARGET_PATHS.has(k),
    );
    return validTargets.length > 0;
  }

  describe('observational lessons (always pass)', () => {
    it('accepts risk_observation with null proposed_config_change', () => {
      expect(passesGate3({ lesson_kind: 'risk_observation', proposed_config_change: null })).toBe(true);
    });

    it('accepts risk_observation with undefined proposed_config_change', () => {
      expect(passesGate3({ lesson_kind: 'risk_observation' })).toBe(true);
    });

    it('accepts unknown lesson_kind (not in ACTIONABLE) with anything', () => {
      expect(passesGate3({ lesson_kind: 'trade_metrics', proposed_config_change: null })).toBe(true);
      expect(passesGate3({ lesson_kind: 'portfolio_diagnostic', proposed_config_change: { random: 'x' } })).toBe(true);
    });
  });

  describe('actionable lessons — accept paths', () => {
    it('accepts gate_calibration with valid DB column target', () => {
      expect(
        passesGate3({
          lesson_kind: 'gate_calibration',
          proposed_config_change: { gainers_min_persistence_score: 0.75 },
        }),
      ).toBe(true);
    });

    it('accepts session_filter with valid env var target', () => {
      expect(
        passesGate3({
          lesson_kind: 'session_filter',
          proposed_config_change: { GAINERS_HOUR_BLACKLIST_US_UTC: '17,18,19', note: 'post-lunch chop' },
        }),
      ).toBe(true);
    });

    it('accepts losing_pattern with valid target + note', () => {
      expect(
        passesGate3({
          lesson_kind: 'losing_pattern',
          proposed_config_change: { gainers_min_path_efficiency: 0.7, note: '+3 lessons WR<25%' },
        }),
      ).toBe(true);
    });

    it('accepts exit_rule with valid target', () => {
      expect(
        passesGate3({
          lesson_kind: 'exit_rule',
          proposed_config_change: { gainers_default_sl_pct: 1.8 },
        }),
      ).toBe(true);
    });

    it('accepts entry_discipline with valid target', () => {
      expect(
        passesGate3({
          lesson_kind: 'entry_discipline',
          proposed_config_change: { gainers_min_change_pct: 3.5 },
        }),
      ).toBe(true);
    });
  });

  describe('actionable lessons — reject paths', () => {
    it('rejects gate_calibration with null proposed_config_change', () => {
      expect(
        passesGate3({ lesson_kind: 'gate_calibration', proposed_config_change: null }),
      ).toBe(false);
    });

    it('rejects gate_calibration with undefined proposed_config_change', () => {
      expect(passesGate3({ lesson_kind: 'gate_calibration' })).toBe(false);
    });

    it('rejects gate_calibration with empty object', () => {
      expect(
        passesGate3({ lesson_kind: 'gate_calibration', proposed_config_change: {} }),
      ).toBe(false);
    });

    it('rejects gate_calibration with unknown target_path', () => {
      expect(
        passesGate3({
          lesson_kind: 'gate_calibration',
          proposed_config_change: { unknown_field: 0.5 },
        }),
      ).toBe(false);
    });

    it('rejects losing_pattern with only meta keys (note + reason)', () => {
      expect(
        passesGate3({
          lesson_kind: 'losing_pattern',
          proposed_config_change: { note: 'description only', reason: 'because' },
        }),
      ).toBe(false);
    });

    it('rejects winning_pattern with old prompt format { target, value }', () => {
      // Si Gemini retombe sur l'ancien wrapper format, parser doit rejeter
      // car ni "target" ni "value" ne sont des target_path valides
      expect(
        passesGate3({
          lesson_kind: 'winning_pattern',
          proposed_config_change: { target: 'gainers_min_persistence_score', value: 0.6 },
        }),
      ).toBe(false);
    });

    it('rejects sizing_rule with target_path mistyped', () => {
      expect(
        passesGate3({
          lesson_kind: 'sizing_rule',
          proposed_config_change: { gainers_min_persistance_score: 0.75 }, // typo "persistance"
        }),
      ).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('case-sensitive on target_path (lowercase env var = invalid)', () => {
      expect(
        passesGate3({
          lesson_kind: 'session_filter',
          proposed_config_change: { gainers_hour_blacklist_us_utc: '17' },
        }),
      ).toBe(false);
    });

    it('meta keys are case-insensitive (NOTE vs note)', () => {
      // Only meta keys → reject (no valid target)
      expect(
        passesGate3({
          lesson_kind: 'gate_calibration',
          proposed_config_change: { NOTE: 'meta', Reason: 'meta' },
        }),
      ).toBe(false);
    });

    it('accepts mix of valid target + meta keys', () => {
      expect(
        passesGate3({
          lesson_kind: 'gate_calibration',
          proposed_config_change: {
            gainers_min_persistence_score: 0.75,
            note: 'why',
            reason: 'because',
          },
        }),
      ).toBe(true);
    });
  });
});
