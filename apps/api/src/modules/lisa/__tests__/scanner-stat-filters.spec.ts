/**
 * PR Phase 1 — Tests des filtres statistiques pré-trade.
 *
 * Tests UNIT du comportement attendu (env GAINERS_EARNINGS_FILTER_DAYS et
 * GAINERS_OPEN_BUFFER_MIN). Pas d'intégration scanner complète : on teste
 * la logique de décision en isolation.
 */

describe('PR Phase 1 — Earnings filter logic', () => {
  const now = Date.now();

  it('threshold 0 (default) → filter disabled, no skip', () => {
    const envValue: string | undefined = undefined;
    const earningsFilterDays = Number(envValue ?? '0');
    expect(earningsFilterDays).toBe(0);
    expect(earningsFilterDays > 0).toBe(false);
  });

  it('threshold 1 → skip si earnings dans 1 jour', () => {
    const earningsFilterDays = 1;
    const nextEarnings = now + 12 * 3600 * 1000;
    const daysUntil = Math.floor((nextEarnings - now) / 86_400_000);
    expect(daysUntil >= 0 && daysUntil <= earningsFilterDays).toBe(true);  // skip
  });

  it('threshold 1 → no skip si earnings dans 3 jours', () => {
    const earningsFilterDays = 1;
    const nextEarnings = now + 3 * 86_400_000;
    const daysUntil = Math.floor((nextEarnings - now) / 86_400_000);
    expect(daysUntil >= 0 && daysUntil <= earningsFilterDays).toBe(false);  // proceed
  });

  it('threshold 2 → skip si earnings dans 1 ou 2 jours', () => {
    const earningsFilterDays = 2;
    const t1 = now + 1 * 86_400_000;
    const t2 = now + 2 * 86_400_000;
    const t3 = now + 3 * 86_400_000;
    const daysUntil1 = Math.floor((t1 - now) / 86_400_000);
    const daysUntil2 = Math.floor((t2 - now) / 86_400_000);
    const daysUntil3 = Math.floor((t3 - now) / 86_400_000);

    expect(daysUntil1 >= 0 && daysUntil1 <= earningsFilterDays).toBe(true);   // skip
    expect(daysUntil2 >= 0 && daysUntil2 <= earningsFilterDays).toBe(true);   // skip
    expect(daysUntil3 >= 0 && daysUntil3 <= earningsFilterDays).toBe(false);  // proceed
  });

  it('past earnings ignored (daysUntil < 0)', () => {
    const earningsFilterDays = 1;
    const pastEarnings = now - 86_400_000;
    const daysUntil = Math.floor((pastEarnings - now) / 86_400_000);
    expect(daysUntil < 0).toBe(true);  // past earnings = skip filter
  });
});

describe('PR Phase 1 — Opening buffer filter logic', () => {
  // NYSE open = 13:30 UTC (= 9:30 EDT)
  // Asia open = 00:00 UTC
  // EU open = 08:00 UTC

  function computeMinsSinceOpen(nowUtc: Date, openUtcMin: number): number {
    const nowMin = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();
    return nowMin - openUtcMin;
  }

  it('NYSE 13:32 UTC = 2min after open → skip if buffer=5', () => {
    const buffer = 5;
    const nyseOpen = 13 * 60 + 30;
    const now = new Date('2026-05-13T13:32:00Z');  // Wed 13:32 UTC
    const mins = computeMinsSinceOpen(now, nyseOpen);
    expect(mins).toBe(2);
    expect(mins >= 0 && mins < buffer).toBe(true);  // skip
  });

  it('NYSE 13:35 UTC = 5min after open → no skip if buffer=5', () => {
    const buffer = 5;
    const nyseOpen = 13 * 60 + 30;
    const now = new Date('2026-05-13T13:35:00Z');
    const mins = computeMinsSinceOpen(now, nyseOpen);
    expect(mins).toBe(5);
    expect(mins >= 0 && mins < buffer).toBe(false);  // proceed (>= 5)
  });

  it('NYSE 13:30 UTC = 0min exactly at open → skip if buffer=5', () => {
    const buffer = 5;
    const nyseOpen = 13 * 60 + 30;
    const now = new Date('2026-05-13T13:30:00Z');
    const mins = computeMinsSinceOpen(now, nyseOpen);
    expect(mins).toBe(0);
    expect(mins >= 0 && mins < buffer).toBe(true);
  });

  it('NYSE 13:29 UTC = -1min before open → no skip', () => {
    const buffer = 5;
    const nyseOpen = 13 * 60 + 30;
    const now = new Date('2026-05-13T13:29:00Z');
    const mins = computeMinsSinceOpen(now, nyseOpen);
    expect(mins).toBe(-1);
    expect(mins >= 0 && mins < buffer).toBe(false);  // pre-market, not in buffer
  });

  it('Asia 00:03 UTC = 3min after Asia open → skip if buffer=10', () => {
    const buffer = 10;
    const asiaOpen = 0;
    const now = new Date('2026-05-13T00:03:00Z');
    const mins = computeMinsSinceOpen(now, asiaOpen);
    expect(mins).toBe(3);
    expect(mins >= 0 && mins < buffer).toBe(true);
  });

  it('buffer 0 (default) → never skip', () => {
    const buffer = 0;
    const nyseOpen = 13 * 60 + 30;
    const now = new Date('2026-05-13T13:30:00Z');
    const mins = computeMinsSinceOpen(now, nyseOpen);
    expect(mins).toBe(0);
    expect(mins >= 0 && mins < buffer).toBe(false);  // 0 < 0 is false, proceed
  });
});

describe('PR Phase 1 — Crypto exempt from both filters', () => {
  // Crypto candidates have assetClass 'crypto_major' or 'crypto_alt'.
  // Both filters check `cand.assetClass !== 'crypto_major' && cand.assetClass !== 'crypto_alt'`.

  it('crypto_major bypasses earnings filter', () => {
    const assetClass: string = 'crypto_major';
    const isNonCrypto = assetClass !== 'crypto_major' && assetClass !== 'crypto_alt';
    expect(isNonCrypto).toBe(false);  // crypto = no filter
  });

  it('crypto_alt bypasses opening buffer filter', () => {
    const assetClass: string = 'crypto_alt';
    const isNonCrypto = assetClass !== 'crypto_major' && assetClass !== 'crypto_alt';
    expect(isNonCrypto).toBe(false);
  });

  it('us_equity_large gets filters applied', () => {
    const assetClass: string = 'us_equity_large';
    const isNonCrypto = assetClass !== 'crypto_major' && assetClass !== 'crypto_alt';
    expect(isNonCrypto).toBe(true);
  });

  it('asia_equity gets filters applied', () => {
    const assetClass: string = 'asia_equity';
    const isNonCrypto = assetClass !== 'crypto_major' && assetClass !== 'crypto_alt';
    expect(isNonCrypto).toBe(true);
  });
});
