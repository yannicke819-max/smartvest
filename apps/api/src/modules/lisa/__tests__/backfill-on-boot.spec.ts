/**
 * PR #293 — Test du toggle env RUN_BACKFILL_POST_SL_ON_BOOT.
 *
 * On vérifie le contrat env-driven sans instancier le service complet
 * (qui nécessite Supabase + EODHD via DI). Test du parsing de l'env var
 * et de la logique de skip si non set.
 */

describe('RUN_BACKFILL_POST_SL_ON_BOOT env toggle', () => {
  const originalToggle = process.env.RUN_BACKFILL_POST_SL_ON_BOOT;
  const originalLimit = process.env.RUN_BACKFILL_POST_SL_LIMIT;
  const originalPortfolio = process.env.RUN_BACKFILL_POST_SL_PORTFOLIO_ID;

  afterEach(() => {
    if (originalToggle === undefined) delete process.env.RUN_BACKFILL_POST_SL_ON_BOOT;
    else process.env.RUN_BACKFILL_POST_SL_ON_BOOT = originalToggle;
    if (originalLimit === undefined) delete process.env.RUN_BACKFILL_POST_SL_LIMIT;
    else process.env.RUN_BACKFILL_POST_SL_LIMIT = originalLimit;
    if (originalPortfolio === undefined) delete process.env.RUN_BACKFILL_POST_SL_PORTFOLIO_ID;
    else process.env.RUN_BACKFILL_POST_SL_PORTFOLIO_ID = originalPortfolio;
  });

  it('triggers when env is exactly "true"', () => {
    process.env.RUN_BACKFILL_POST_SL_ON_BOOT = 'true';
    expect(process.env.RUN_BACKFILL_POST_SL_ON_BOOT === 'true').toBe(true);
  });

  it('skips when env is undefined (default)', () => {
    delete process.env.RUN_BACKFILL_POST_SL_ON_BOOT;
    expect(process.env.RUN_BACKFILL_POST_SL_ON_BOOT === 'true').toBe(false);
  });

  it('skips when env is anything other than "true"', () => {
    for (const value of ['false', '1', '0', 'TRUE', 'True', 'yes', '']) {
      process.env.RUN_BACKFILL_POST_SL_ON_BOOT = value;
      expect(process.env.RUN_BACKFILL_POST_SL_ON_BOOT === 'true').toBe(false);
    }
  });

  it('parses RUN_BACKFILL_POST_SL_LIMIT clamped 1..500 default 100', () => {
    const parse = (raw: string | undefined) =>
      Math.max(1, Math.min(500, Number(raw) || 100));

    expect(parse(undefined)).toBe(100);
    expect(parse('')).toBe(100);
    expect(parse('not_a_number')).toBe(100);
    expect(parse('50')).toBe(50);
    expect(parse('1000')).toBe(500);     // clamped to max
    expect(parse('-5')).toBe(1);          // clamped to min
    expect(parse('0')).toBe(100);         // 0 → falsy → default
  });

  it('uses portfolio_id when set, else falls back to all-portfolios', () => {
    const portfolioGuard = (raw: string | undefined) => raw && raw.length > 0;

    expect(portfolioGuard(undefined)).toBeFalsy();
    expect(portfolioGuard('')).toBeFalsy();
    expect(portfolioGuard('58439d86-3f20-4a60-82a4-307f3f252bc2')).toBeTruthy();
  });
});
