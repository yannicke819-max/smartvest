/**
 * Smoke tests pour LessonAutoApplyService — focus parser key format
 * (fix 31/05/2026 root cause : Gemini emit nude keys, parser only accepted
 * `lisa_session_configs.<col>` prefix → 0% lessons auto-applied).
 *
 * Tests le parser isolé (pas le runtime complet — pas de Supabase mock).
 */

describe('LessonAutoApplyService — key format parser (fix 31/05/2026)', () => {
  // Reproduction in-source du parser (pas exporté). Si refactor, garder aligné.
  const WHITELIST: ReadonlySet<string> = new Set<string>([
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
  ]);

  function parseTargets(change: Record<string, unknown>): {
    dbColumnTargets: string[];
    envVarTargets: string[];
    metaIgnored: string[];
    unrecognized: string[];
  } {
    const isMetaKey = (t: string) => ['table', 'portfolio_id_only', 'note', 'comment'].includes(t.toLowerCase());
    const isEnvVar = (t: string) => /^[A-Z][A-Z0-9_]+$/.test(t);
    const stripPrefix = (t: string) =>
      t.startsWith('lisa_session_configs.') ? t.slice('lisa_session_configs.'.length) : t;

    const dbColumnTargets: string[] = [];
    const envVarTargets: string[] = [];
    const metaIgnored: string[] = [];
    const unrecognized: string[] = [];

    for (const t of Object.keys(change)) {
      if (isMetaKey(t)) {
        metaIgnored.push(t);
        continue;
      }
      const col = stripPrefix(t);
      if (WHITELIST.has(col)) dbColumnTargets.push(t);
      else if (isEnvVar(t)) envVarTargets.push(t);
      else unrecognized.push(t);
    }

    return { dbColumnTargets, envVarTargets, metaIgnored, unrecognized };
  }

  it('accepte nude col name (Gemini-style) — lesson #11 asia_persistence', () => {
    const change = { gainers_min_persistence_score: 0.7 };
    const r = parseTargets(change);
    expect(r.dbColumnTargets).toEqual(['gainers_min_persistence_score']);
    expect(r.envVarTargets).toEqual([]);
  });

  it('accepte prefix legacy `lisa_session_configs.<col>`', () => {
    const change = { 'lisa_session_configs.gainers_default_sl_pct': 1.5 };
    const r = parseTargets(change);
    expect(r.dbColumnTargets).toEqual(['lisa_session_configs.gainers_default_sl_pct']);
    expect(r.envVarTargets).toEqual([]);
  });

  it('ignore meta keys (table, portfolio_id_only, note) — lesson #6 MAIN', () => {
    const change = {
      table: 'lisa_session_configs',
      portfolio_id_only: '58439d86-3f20-4a60-82a4-307f3f252bc2',
      gainers_default_sl_pct: 1.5,
      gainers_fees_aware_buffer: 1.8,
    };
    const r = parseTargets(change);
    expect(r.dbColumnTargets.sort()).toEqual(['gainers_default_sl_pct', 'gainers_fees_aware_buffer']);
    expect(r.metaIgnored.sort()).toEqual(['portfolio_id_only', 'table']);
    expect(r.unrecognized).toEqual([]);
  });

  it('classifie env vars — lesson #2 crypto disable', () => {
    const change = { GAINERS_DISABLE_CRYPTO_SCANNER: 'true' };
    const r = parseTargets(change);
    expect(r.envVarTargets).toEqual(['GAINERS_DISABLE_CRYPTO_SCANNER']);
    expect(r.dbColumnTargets).toEqual([]);
  });

  it('défense en profondeur : rejette colonne hors whitelist (ex. capital_usd)', () => {
    const change = { capital_usd: 1_000_000, autopilot_enabled: false };
    const r = parseTargets(change);
    // Ni dans whitelist, ni env var format majuscule → unrecognized (silently ignored)
    expect(r.dbColumnTargets).toEqual([]);
    expect(r.envVarTargets).toEqual([]);
    expect(r.unrecognized.sort()).toEqual(['autopilot_enabled', 'capital_usd']);
  });

  it('mix tolérant : ignore typo Gemini sans bloquer toute la lesson', () => {
    const change = {
      gainers_default_sl_pct: 1.5,
      gainers_typo_field: 99, // typo Gemini
      table: 'lisa_session_configs',
    };
    const r = parseTargets(change);
    expect(r.dbColumnTargets).toEqual(['gainers_default_sl_pct']);
    expect(r.unrecognized).toEqual(['gainers_typo_field']);
    expect(r.metaIgnored).toEqual(['table']);
  });
});
