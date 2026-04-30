/**
 * P19e — Regression test for ERR_PACKAGE_PATH_NOT_EXPORTED on yahoo-finance2.
 *
 * Issue #96 (29/04/2026 prod, machine d8d4070a719018 CDG) :
 *   `YahooIntradayService` failed on 100% of tickers in prod with
 *   `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in
 *   /app/node_modules/yahoo-finance2`.
 *
 * Root cause : TypeScript with `module: CommonJS` transpiles `await import(...)`
 * to a bare `require(...)` call. yahoo-finance2 v2 publishes ESM-only with a
 * strict `package.json` `exports.import` field (no `require` condition) →
 * Node rejects the require with the error above.
 *
 * Fix : `new Function('s', 'return import(s);')` builds a dynamic ESM import
 * that tsc cannot transform (the import() lives inside a string body of the
 * Function constructor, parsed at runtime by V8 not by tsc). The `import()`
 * stays as actual ESM dynamic import.
 *
 * NB : Jest's default CJS resolver cannot load yahoo-finance2's ESM-only
 * package even with our Function-bypass, so we cannot test the actual import
 * works in this test runner. The real validation is :
 *   1. tsc compiled output preserves `new Function(...)` (verified manually)
 *   2. Prod /version after deploy + UI Top 20 colonne Score/Path/%change
 *      affichée (et plus '—'). Cf. issue #96 plan de validation.
 *
 * What we CAN test in Jest :
 *   - Service constructor doesn't throw
 *   - toYahooSymbol pure mapping table (no dynamic import involved)
 *   - getCandles graceful degrade: returns null on unknown suffix without
 *     even triggering the import (short-circuit)
 *   - getCandles graceful degrade: returns null on import failure (catch swallows)
 */

import { Logger } from '@nestjs/common';
import { YahooIntradayService } from '../yahoo-intraday.service';

jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

describe('YahooIntradayService — P19e regression guard', () => {
  it('service constructor does not throw on instantiation', () => {
    expect(() => new YahooIntradayService()).not.toThrow();
  });

  it('getCandles returns null and does NOT throw on unknown suffix (short-circuit before dynamic import)', async () => {
    const svc = new YahooIntradayService();
    const result = await svc.getCandles('NOTREAL.UNKNOWNXYZ');
    expect(result).toBeNull();
  });

  it('getCandles returns null and does NOT throw on supported suffix (catch swallows any runtime error)', async () => {
    const svc = new YahooIntradayService();
    // Use a suffix that toYahooSymbol maps successfully → triggers the
    // dynamic import path. Even if the import fails (Jest CJS env, network,
    // rate limit, etc.), the service must catch and return null without
    // letting the error propagate to scanPortfolio.
    const result = await svc.getCandles('AAPL.US');
    // Result can be null (any failure) or an array (network success).
    // Regression check : no exception escaped the try/catch.
    expect(result === null || Array.isArray(result)).toBe(true);
  }, 15_000);

  it('toYahooSymbol pure logic — full mapping table', () => {
    const svc = new YahooIntradayService();
    expect(svc.toYahooSymbol('AAPL.US')).toBe('AAPL');
    expect(svc.toYahooSymbol('199820.KO')).toBe('199820.KS');
    expect(svc.toYahooSymbol('006340.KO')).toBe('006340.KS');
    expect(svc.toYahooSymbol('BHP.AU')).toBe('BHP.AX');
    expect(svc.toYahooSymbol('SHEL.LSE')).toBe('SHEL.L');
    expect(svc.toYahooSymbol('SAP.XETRA')).toBe('SAP.DE');
    expect(svc.toYahooSymbol('600000.SS')).toBe('600000.SS');
    expect(svc.toYahooSymbol('000001.SZ')).toBe('000001.SZ');
    expect(svc.toYahooSymbol('UNKNOWN.WTF')).toBeNull();
    expect(svc.toYahooSymbol('BTC-USD.CC')).toBeNull(); // crypto handled by Binance
    expect(svc.toYahooSymbol('EURUSD.FOREX')).toBeNull();
    expect(svc.toYahooSymbol('')).toBeNull();
  });
});
