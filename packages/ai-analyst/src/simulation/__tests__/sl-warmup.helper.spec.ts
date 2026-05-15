/**
 * Bug #R1 + #R2 + #R6 — Tests du helper warmup SL partagé.
 *
 * Le helper subsume :
 *   - PR #319 (R1) : logique 15min/-3% inline dans mechanical-trading
 *   - PR #320 (R2) : env vars + validation bornes (PR fermée au profit de R6)
 *   - Bug #R6 : extension à risk-monitor (2e chemin SL identifié, 3 leaks
 *     asia_equity la nuit 14→15/05)
 */

export {};

import { evaluateWarmup, formatWarmupLog } from '../sl-warmup.helper';

/** Helper de test : entry timestamp à N min dans le passé. */
function tsAgo(ageMin: number): string {
  return new Date(Date.now() - ageMin * 60_000).toISOString();
}

/** Capture les warns émis lors de la résolution des env vars. */
function makeLogger(): { warn: (msg: string) => void; warnings: string[] } {
  const warnings: string[] = [];
  return { warn: (msg: string) => warnings.push(msg), warnings };
}

describe('Bug #R6 — evaluateWarmup decision (spec cases)', () => {
  // Helper pour passer des paramètres explicites et neutraliser process.env.
  const cfg = { warmupMin: 15, severeLossPct: -3.0 };

  it('entryTimestamp undefined → shouldHonorStop=true (conservateur)', () => {
    const d = evaluateWarmup(undefined, 5.0, 4.85, true, cfg);
    expect(d.shouldHonorStop).toBe(true);
    expect(d.reason).toBe('no_timestamp');
    expect(d.ageMin).toBe(Infinity);
  });

  it('entryTimestamp null → no_timestamp', () => {
    const d = evaluateWarmup(null, 5.0, 4.85, true, cfg);
    expect(d.shouldHonorStop).toBe(true);
    expect(d.reason).toBe('no_timestamp');
  });

  it('entryTimestamp invalide ("foo") → no_timestamp', () => {
    const d = evaluateWarmup('foo', 5.0, 4.85, true, cfg);
    expect(d.shouldHonorStop).toBe(true);
    expect(d.reason).toBe('no_timestamp');
  });

  it('ageMin=5, pnl=-2% (long) → warmup_skip (shouldHonorStop=false)', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, cfg);
    expect(d.shouldHonorStop).toBe(false);
    expect(d.reason).toBe('warmup_skip');
    expect(d.unrealizedPnlPct).toBeCloseTo(-2.0, 5);
  });

  it('ageMin=5, pnl=-3.5% (long) → warmup_override_severe_loss', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.825, true, cfg);
    expect(d.shouldHonorStop).toBe(true);
    expect(d.reason).toBe('warmup_override_severe_loss');
    expect(d.unrealizedPnlPct).toBeCloseTo(-3.5, 5);
  });

  it('ageMin=20, pnl=-2% → sl_honored_post_warmup', () => {
    const d = evaluateWarmup(tsAgo(20), 5.0, 4.9, true, cfg);
    expect(d.shouldHonorStop).toBe(true);
    expect(d.reason).toBe('sl_honored_post_warmup');
  });

  it('EDGE ageMin exactement 15.0 → sl_honored_post_warmup (fenêtre exclusive)', () => {
    const d = evaluateWarmup(tsAgo(15.0), 5.0, 4.9, true, cfg);
    expect(d.reason).toBe('sl_honored_post_warmup');
  });

  it('EDGE pnl exactement -3.0 → severe override (seuil inclusif)', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.85, true, cfg);
    expect(d.unrealizedPnlPct).toBeCloseTo(-3.0, 5);
    expect(d.reason).toBe('warmup_override_severe_loss');
  });
});

describe('Bug #R6 — direction-aware P&L (symétrie long/short)', () => {
  const cfg = { warmupMin: 15, severeLossPct: -3.0 };

  it('short avec prix AU-DESSUS entry → pnl négatif (perte)', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 5.10, false, cfg);  // short: live > entry = perte
    expect(d.unrealizedPnlPct).toBeCloseTo(-2.0, 5);
    expect(d.reason).toBe('warmup_skip');  // perte modérée, fresh → skip
  });

  it('short avec perte sévère -3.5% → severe override', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 5.175, false, cfg);
    expect(d.unrealizedPnlPct).toBeCloseTo(-3.5, 5);
    expect(d.reason).toBe('warmup_override_severe_loss');
  });

  it('long avec prix sous entry → pnl négatif (perte), même magnitude que short symétrique', () => {
    const longD = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, cfg);
    const shortD = evaluateWarmup(tsAgo(5), 5.0, 5.1, false, cfg);
    expect(longD.unrealizedPnlPct).toBeCloseTo(shortD.unrealizedPnlPct, 5);
  });
});

// ---------------------------------------------------------------------------
// Bornes env vars — Bug #R2 subsumé dans le helper
// ---------------------------------------------------------------------------
describe('Bug #R6 — resolveWarmupMin via env (R2 subsumé)', () => {
  let originalEnv: string | undefined;
  beforeEach(() => { originalEnv = process.env.GAINERS_SL_WARMUP_MIN; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GAINERS_SL_WARMUP_MIN;
    else process.env.GAINERS_SL_WARMUP_MIN = originalEnv;
  });

  it('env absente → fallback 15 (default)', () => {
    delete process.env.GAINERS_SL_WARMUP_MIN;
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true);
    expect(d.warmupMin).toBe(15);
  });

  it('env valide ("20") → 20', () => {
    process.env.GAINERS_SL_WARMUP_MIN = '20';
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true);
    expect(d.warmupMin).toBe(20);
  });

  it('env >60 → capped 60 + warn', () => {
    process.env.GAINERS_SL_WARMUP_MIN = '120';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.warmupMin).toBe(60);
    expect(logger.warnings.some((w) => w.includes('suspicious') && w.includes('capped'))).toBe(true);
  });

  it('env <0 → fallback 15 + warn', () => {
    process.env.GAINERS_SL_WARMUP_MIN = '-5';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.warmupMin).toBe(15);
    expect(logger.warnings.some((w) => w.includes('invalid') && w.includes('fallback 15'))).toBe(true);
  });

  it('env NaN ("abc") → fallback 15 + warn', () => {
    process.env.GAINERS_SL_WARMUP_MIN = 'abc';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.warmupMin).toBe(15);
    expect(logger.warnings.some((w) => w.includes('invalid'))).toBe(true);
  });

  it('env=0 → valide (0 = warmup désactivé), pas de warn', () => {
    process.env.GAINERS_SL_WARMUP_MIN = '0';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.warmupMin).toBe(0);
    expect(logger.warnings.length).toBe(0);
  });
});

describe('Bug #R6 — resolveWarmupCatastrophicPct via env (R2 subsumé)', () => {
  let originalEnv: string | undefined;
  beforeEach(() => { originalEnv = process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT;
    else process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = originalEnv;
  });

  it('env absente → fallback -3 (default)', () => {
    delete process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT;
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true);
    expect(d.severeLossPct).toBe(-3.0);
  });

  it('env valide ("-2.5") → -2.5', () => {
    process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = '-2.5';
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true);
    expect(d.severeLossPct).toBe(-2.5);
  });

  it('env >0 → fallback -3 + warn', () => {
    process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = '2.5';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.severeLossPct).toBe(-3.0);
    expect(logger.warnings.some((w) => w.includes('should be negative'))).toBe(true);
  });

  it('env <-10 → cap -10 + warn', () => {
    process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = '-15';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.severeLossPct).toBe(-10);
    expect(logger.warnings.some((w) => w.includes('too lenient') && w.includes('capped'))).toBe(true);
  });

  it('env NaN ("foo") → fallback -3 + warn', () => {
    process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = 'foo';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.severeLossPct).toBe(-3.0);
    expect(logger.warnings.some((w) => w.includes('invalid'))).toBe(true);
  });

  it('env=0 → valide (0 = tout est sévère), pas de warn', () => {
    process.env.GAINERS_SL_WARMUP_CATASTROPHIC_PCT = '0';
    const logger = makeLogger();
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { logger });
    expect(d.severeLossPct).toBe(0);
    expect(logger.warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatWarmupLog — log enrichi avec config active
// ---------------------------------------------------------------------------
describe('Bug #R6 — formatWarmupLog enrichi (R2 subsumé)', () => {
  it('contient warmup_min_config et warmup_catastrophic_pct_config', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { warmupMin: 15, severeLossPct: -3 });
    const log = formatWarmupLog(d, {
      symbol: 'AAPL.US',
      positionId: 'p1',
      service: 'mechanical-trading',
      slPrice: '4.85',
    });
    expect(log).toContain('warmup_min_config=15');
    expect(log).toContain('warmup_catastrophic_pct_config=-3');
  });

  it('contient le tag service= pour identifier le chemin émetteur', () => {
    const d = evaluateWarmup(tsAgo(5), 5.0, 4.9, true);
    const logMech = formatWarmupLog(d, { symbol: 'X', positionId: 'p1', service: 'mechanical-trading' });
    const logRisk = formatWarmupLog(d, { symbol: 'X', positionId: 'p1', service: 'risk-monitor' });
    expect(logMech).toContain('service=mechanical-trading');
    expect(logRisk).toContain('service=risk-monitor');
  });

  it('contient le decision (warmup_skip / sl_honored_post_warmup / etc.)', () => {
    const skip = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { warmupMin: 15, severeLossPct: -3 });
    expect(formatWarmupLog(skip, { symbol: 'X', positionId: 'p1', service: 's' })).toContain('decision=warmup_skip');

    const honored = evaluateWarmup(tsAgo(20), 5.0, 4.9, true, { warmupMin: 15, severeLossPct: -3 });
    expect(formatWarmupLog(honored, { symbol: 'X', positionId: 'p1', service: 's' })).toContain('decision=sl_honored_post_warmup');
  });

  it('age_min=Infinity formaté lisiblement (cas no_timestamp)', () => {
    const d = evaluateWarmup(undefined, 5.0, 4.9, true);
    const log = formatWarmupLog(d, { symbol: 'X', positionId: 'p1', service: 's' });
    expect(log).toContain('age_min=Infinity');
    expect(log).toContain('decision=no_timestamp');
  });
});

// ---------------------------------------------------------------------------
// Bug #R6 — invariants (chemin alternatif risk-monitor doit être protégé)
// ---------------------------------------------------------------------------
describe('Bug #R6 — invariant : décision identique quel que soit le caller', () => {
  it('même paramètres → même décision (mechanical-trading vs risk-monitor)', () => {
    // Le helper est pure : mêmes inputs → mêmes outputs, quel que soit le service.
    const d1 = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { warmupMin: 15, severeLossPct: -3 });
    const d2 = evaluateWarmup(tsAgo(5), 5.0, 4.9, true, { warmupMin: 15, severeLossPct: -3 });
    expect(d1.shouldHonorStop).toBe(d2.shouldHonorStop);
    expect(d1.reason).toBe(d2.reason);
  });

  it('scénario 222420.KQ leak (6.7min, -2.92%, long) → warmup_skip (fixé par Bug #R6)', () => {
    // Avant Bug #R6, ce close passait par risk-monitor sans warmup → leak.
    const d = evaluateWarmup(tsAgo(6.7), 1564.5, 1518.8, true, { warmupMin: 15, severeLossPct: -3 });
    expect(d.unrealizedPnlPct).toBeLessThan(-2.9);
    expect(d.unrealizedPnlPct).toBeGreaterThan(-3.0);  // borderline mais > -3 → skip
    expect(d.reason).toBe('warmup_skip');
    expect(d.shouldHonorStop).toBe(false);
  });

  it('scénario 009830.KO (4.8min, -3.86%, long) → severe override (garde-fou OK, déjà bloqué pré-R6)', () => {
    const d = evaluateWarmup(tsAgo(4.8), 100.0, 96.14, true, { warmupMin: 15, severeLossPct: -3 });
    expect(d.unrealizedPnlPct).toBeLessThan(-3);
    expect(d.reason).toBe('warmup_override_severe_loss');
    expect(d.shouldHonorStop).toBe(true);
  });
});
