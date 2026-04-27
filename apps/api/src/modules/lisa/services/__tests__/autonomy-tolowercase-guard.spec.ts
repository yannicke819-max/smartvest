/**
 * PR B — defensive guards autour de `.toLowerCase()` sur des champs typés
 * `string` mais provenant potentiellement d'objets Supabase non-mappés.
 *
 * Verifie le pattern `(field ?? '').toLowerCase()` plutôt que
 * `field.toLowerCase()` qui throw TypeError si field est undefined.
 *
 * Tests purs : on isole le pattern (helpers privés inaccessibles), on
 * vérifie le comportement attendu sur des inputs adversariaux.
 *
 * Cf. fix/position-data-integrity (PR #16) qui a fixé la root cause
 * (mapper). Ce PR est une ceinture défensive pour défaillance future
 * d'un load site futur qui contournerait le mapper.
 */

describe('toLowerCase defensive pattern (?? "")', () => {
  it('returns empty string when field is undefined', () => {
    const field: string | undefined = undefined;
    expect((field ?? '').toLowerCase()).toBe('');
    expect(() => (field ?? '').toLowerCase()).not.toThrow();
  });

  it('returns empty string when field is null', () => {
    const field: string | null = null;
    expect((field ?? '').toLowerCase()).toBe('');
    expect(() => (field ?? '').toLowerCase()).not.toThrow();
  });

  it('lowercases the value when field is a real string', () => {
    const f1: string | undefined = 'CRYPTO_BITCOIN';
    const f2: string | undefined = 'Equity_US_Large';
    expect((f1 ?? '').toLowerCase()).toBe('crypto_bitcoin');
    expect((f2 ?? '').toLowerCase()).toBe('equity_us_large');
  });

  it('".includes(...)" returns false (not throw) on undefined input via ?? guard', () => {
    const cls: string | undefined = undefined;
    const result = (cls ?? '').toLowerCase().includes('crypto');
    expect(result).toBe(false);
  });

  it('repro production bug 27/04 : pos.assetClass undefined avec guard ?? ne crashe pas', () => {
    // Avant le mapper PR #16, `pos.assetClass` était undefined.
    // Le `(pos.assetClass ?? '').toLowerCase()` est la ceinture si jamais
    // un load site futur rate le mapper.
    interface OpenPositionMinimal {
      symbol: string;
      assetClass: string;
      direction: string;
      entryPrice: string;
    }
    const fakeRawPos = {
      symbol: 'BTC',
      // assetClass intentionnellement absent (simule mapper miss)
      direction: 'long',
      entryPrice: '76875.69',
    } as unknown as OpenPositionMinimal;

    // Ancien code (crashait) : fakeRawPos.assetClass.toLowerCase()
    expect(() => fakeRawPos.assetClass.toLowerCase()).toThrow();

    // Nouveau code (defensive) : ne crashe pas
    expect(() => (fakeRawPos.assetClass ?? '').toLowerCase()).not.toThrow();
    expect((fakeRawPos.assetClass ?? '').toLowerCase().includes('crypto')).toBe(false);
  });
});
