/**
 * Tests pour macro-fallback.helper — parsers Yahoo Finance + Stooq.
 *
 * Pure functions, pas de mock HTTP — on injecte directement les payloads
 * que retourne chaque provider à des moments différents (success, partial,
 * empty). Cela garantit que le caller (LisaService.fetchYahoo / fetchStooq)
 * voit toujours soit un nombre > 0 valide, soit null (jamais NaN, jamais
 * negative, jamais 0).
 */
import {
  buildAlphaVantageGlobalQuoteUrl,
  buildStooqCsvUrl,
  buildYahooChartUrl,
  fetchWithRetry,
  parseAlphaVantageGlobalQuoteResponse,
  parseStooqCsvResponse,
  parseYahooChartResponse,
} from '../macro-fallback.helper';

describe('parseYahooChartResponse', () => {
  it('extracts regularMarketPrice (path 1, fresh price)', () => {
    const json = {
      chart: {
        result: [{
          meta: { regularMarketPrice: 22.65, currency: 'USD' },
          indicators: { quote: [{ close: [22.5, 22.6, 22.65] }] },
        }],
      },
    };
    expect(parseYahooChartResponse(json)).toBe(22.65);
  });

  it('falls back to last non-null close in indicators.quote (path 2)', () => {
    const json = {
      chart: {
        result: [{
          meta: { regularMarketPrice: NaN }, // path 1 fails
          indicators: { quote: [{ close: [22.5, 22.6, null, 22.85] }] },
        }],
      },
    };
    expect(parseYahooChartResponse(json)).toBe(22.85);
  });

  it('skips trailing nulls and finds last valid close', () => {
    const json = {
      chart: {
        result: [{
          meta: {},
          indicators: { quote: [{ close: [22.5, 22.6, null, null] }] },
        }],
      },
    };
    expect(parseYahooChartResponse(json)).toBe(22.6);
  });

  it('falls back to adjclose (path 3)', () => {
    const json = {
      chart: {
        result: [{
          meta: {},
          indicators: {
            quote: [{ close: [null, null] }],
            adjclose: [{ adjclose: [22.4, null, 22.7] }],
          },
        }],
      },
    };
    expect(parseYahooChartResponse(json)).toBe(22.7);
  });

  it('returns null on chart.error', () => {
    const json = { chart: { error: { code: 'Not Found' }, result: null } };
    expect(parseYahooChartResponse(json)).toBeNull();
  });

  it('returns null on missing chart', () => {
    expect(parseYahooChartResponse({})).toBeNull();
  });

  it('returns null on empty result array', () => {
    expect(parseYahooChartResponse({ chart: { result: [] } })).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(parseYahooChartResponse(null)).toBeNull();
    expect(parseYahooChartResponse(undefined)).toBeNull();
    expect(parseYahooChartResponse('not json')).toBeNull();
    expect(parseYahooChartResponse(42)).toBeNull();
  });

  it('rejects 0 and negative prices (would be corrupted data)', () => {
    expect(parseYahooChartResponse({
      chart: { result: [{ meta: { regularMarketPrice: 0 }, indicators: { quote: [{ close: [0] }] } }] },
    })).toBeNull();
    expect(parseYahooChartResponse({
      chart: { result: [{ meta: { regularMarketPrice: -1 }, indicators: { quote: [{ close: [-1] }] } }] },
    })).toBeNull();
  });

  it('extracts a realistic VIX value (~22.5) from a typical Yahoo response', () => {
    // Snapshot d'une réponse réelle Yahoo /v8/finance/chart/^VIX
    const realResponse = {
      chart: {
        result: [{
          meta: {
            currency: 'USD',
            symbol: '^VIX',
            regularMarketPrice: 22.41,
            chartPreviousClose: 21.89,
            regularMarketTime: 1714248000,
          },
          timestamp: [1714248000],
          indicators: {
            quote: [{
              high: [22.85],
              low: [21.95],
              open: [22.05],
              close: [22.41],
              volume: [0],
            }],
          },
        }],
        error: null,
      },
    };
    expect(parseYahooChartResponse(realResponse)).toBe(22.41);
  });
});

describe('parseStooqCsvResponse', () => {
  it('extracts close from a single-row CSV', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:30:00,22.10,22.85,21.90,22.65,N/D';
    expect(parseStooqCsvResponse(csv)).toBe(22.65);
  });

  it('handles CRLF line endings (Windows-style)', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\r\n' +
      '^VIX,2026-04-27,15:30:00,22.10,22.85,21.90,22.65,N/D\r\n';
    expect(parseStooqCsvResponse(csv)).toBe(22.65);
  });

  it('takes last numeric close when multiple data rows present', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:00:00,22.10,22.85,21.90,22.65,N/D\n' +
      '^VIX,2026-04-27,15:30:00,22.65,22.95,22.50,22.85,N/D';
    expect(parseStooqCsvResponse(csv)).toBe(22.85);
  });

  it('skips rows where close is N/D', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:00:00,22.10,22.85,21.90,22.65,N/D\n' +
      '^VIX,2026-04-27,15:30:00,N/D,N/D,N/D,N/D,N/D';
    // 2e ligne N/D → recule → 1re ligne 22.65
    expect(parseStooqCsvResponse(csv)).toBe(22.65);
  });

  it('skips rows where close is "-"', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:00:00,22.10,22.85,21.90,22.65,N/D\n' +
      '^VIX,2026-04-27,15:30:00,-,-,-,-,-';
    expect(parseStooqCsvResponse(csv)).toBe(22.65);
  });

  it('returns null when only the header is present (no data row)', () => {
    expect(parseStooqCsvResponse('Symbol,Date,Time,Open,High,Low,Close,Volume')).toBeNull();
  });

  it('returns null when CSV is empty / whitespace', () => {
    expect(parseStooqCsvResponse('')).toBeNull();
    expect(parseStooqCsvResponse('   \n\n  ')).toBeNull();
  });

  it('returns null when Close column is missing from header', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Volume\n' +
      '^VIX,2026-04-27,15:30:00,22.10,22.85,21.90,N/D';
    expect(parseStooqCsvResponse(csv)).toBeNull();
  });

  it('returns null when all data rows have invalid close', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:00:00,N/D,N/D,N/D,N/D,N/D\n' +
      '^VIX,2026-04-27,15:30:00,N/D,N/D,N/D,-,N/D';
    expect(parseStooqCsvResponse(csv)).toBeNull();
  });

  it('rejects 0 and negative close (corrupted data)', () => {
    const csv =
      'Symbol,Date,Time,Open,High,Low,Close,Volume\n' +
      '^VIX,2026-04-27,15:30:00,22.10,22.85,21.90,0,N/D';
    expect(parseStooqCsvResponse(csv)).toBeNull();
  });

  it('handles non-string input gracefully', () => {
    expect(parseStooqCsvResponse(null as unknown as string)).toBeNull();
    expect(parseStooqCsvResponse(undefined as unknown as string)).toBeNull();
    expect(parseStooqCsvResponse(123 as unknown as string)).toBeNull();
  });
});

describe('URL builders', () => {
  it('buildYahooChartUrl encodes the symbol (^VIX → %5EVIX)', () => {
    expect(buildYahooChartUrl('^VIX')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
    );
  });

  it('buildYahooChartUrl supports DX-Y.NYB symbol', () => {
    expect(buildYahooChartUrl('DX-Y.NYB')).toBe(
      'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1d&range=1d',
    );
  });

  it('buildStooqCsvUrl lowercases + encodes the symbol', () => {
    expect(buildStooqCsvUrl('^VIX')).toBe(
      'https://stooq.com/q/l/?s=%5Evix&f=sd2t2ohlcv&h&e=csv',
    );
  });

  it('buildStooqCsvUrl handles ^dxy lowercased', () => {
    expect(buildStooqCsvUrl('^DXY')).toBe(
      'https://stooq.com/q/l/?s=%5Edxy&f=sd2t2ohlcv&h&e=csv',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-B — Alpha Vantage parser + URL builder
// ─────────────────────────────────────────────────────────────────────────────

describe('parseAlphaVantageGlobalQuoteResponse', () => {
  it('extracts price from "05. price" string field', () => {
    const json = {
      'Global Quote': {
        '01. symbol': 'VIX',
        '05. price': '22.45',
        '08. previous close': '22.10',
      },
    };
    expect(parseAlphaVantageGlobalQuoteResponse(json)).toBe(22.45);
  });

  it('returns null on rate-limit "Information" envelope (free tier 5/min hit)', () => {
    const json = {
      Information: 'We have detected your API key as ABC. Our standard API call frequency is 5 calls per minute and 500 calls per day.',
    };
    expect(parseAlphaVantageGlobalQuoteResponse(json)).toBeNull();
  });

  it('returns null on "Note" envelope (also rate-limit indicator)', () => {
    const json = {
      Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute and 500 calls per day.',
    };
    expect(parseAlphaVantageGlobalQuoteResponse(json)).toBeNull();
  });

  it('returns null on "Error Message" envelope (invalid symbol)', () => {
    const json = { 'Error Message': 'Invalid API call. Please retry or visit the documentation.' };
    expect(parseAlphaVantageGlobalQuoteResponse(json)).toBeNull();
  });

  it('returns null on empty Global Quote object', () => {
    const json = { 'Global Quote': {} };
    expect(parseAlphaVantageGlobalQuoteResponse(json)).toBeNull();
  });

  it('returns null on missing Global Quote', () => {
    expect(parseAlphaVantageGlobalQuoteResponse({})).toBeNull();
  });

  it('returns null on non-object input', () => {
    expect(parseAlphaVantageGlobalQuoteResponse(null)).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse(undefined)).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse('not json')).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse(42)).toBeNull();
  });

  it('rejects 0 / negative / NaN price (corrupted data)', () => {
    expect(parseAlphaVantageGlobalQuoteResponse({ 'Global Quote': { '05. price': '0' } })).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse({ 'Global Quote': { '05. price': '-1.5' } })).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse({ 'Global Quote': { '05. price': 'NaN' } })).toBeNull();
    expect(parseAlphaVantageGlobalQuoteResponse({ 'Global Quote': { '05. price': '' } })).toBeNull();
  });

  it('rejects non-string price field (defensive against schema drift)', () => {
    expect(parseAlphaVantageGlobalQuoteResponse({
      'Global Quote': { '05. price': 22.45 }, // number instead of string
    })).toBeNull();
  });
});

describe('buildAlphaVantageGlobalQuoteUrl', () => {
  it('builds URL when API key is provided', () => {
    expect(buildAlphaVantageGlobalQuoteUrl('VIX', 'XYZ123')).toBe(
      'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=VIX&apikey=XYZ123',
    );
  });

  it('uppercases symbol + URL-encodes both fields', () => {
    expect(buildAlphaVantageGlobalQuoteUrl('vix', 'key with space')).toBe(
      'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=VIX&apikey=key%20with%20space',
    );
  });

  it('returns null when apiKey is null/undefined/empty (caller falls through)', () => {
    expect(buildAlphaVantageGlobalQuoteUrl('VIX', null)).toBeNull();
    expect(buildAlphaVantageGlobalQuoteUrl('VIX', undefined)).toBeNull();
    expect(buildAlphaVantageGlobalQuoteUrl('VIX', '')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-B — fetchWithRetry helper
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
  it('returns the value on first attempt success (no retry)', async () => {
    const fn = jest.fn().mockResolvedValue(22.5);
    const result = await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(result).toBe(22.5);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts when fn returns null', async () => {
    const fn = jest.fn().mockResolvedValue(null);
    const result = await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns the value on second attempt if first fails', async () => {
    const fn = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(22.5);
    const result = await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(result).toBe(22.5);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('catches exceptions and retries (does not propagate)', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(22.5);
    const result = await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(result).toBe(22.5);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('passes a fresh AbortSignal to each attempt', async () => {
    const signals: AbortSignal[] = [];
    const fn = jest.fn(async (signal: AbortSignal) => {
      signals.push(signal);
      return null;
    });
    await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(signals).toHaveLength(3);
    // Chaque signal est un objet distinct (timeout signal créé par tentative)
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]).not.toBe(signals[2]);
  });

  it('respects maxAttempts=1 (no retry)', async () => {
    const fn = jest.fn().mockResolvedValue(null);
    await fetchWithRetry(fn, { maxAttempts: 1, backoffMs: 1, timeoutMs: 1500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clamps maxAttempts < 1 to at least 1', async () => {
    const fn = jest.fn().mockResolvedValue(null);
    await fetchWithRetry(fn, { maxAttempts: 0, backoffMs: 1, timeoutMs: 1500 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses default 3 attempts / 250ms backoff / 1500ms timeout when opts omitted', async () => {
    const fn = jest.fn().mockResolvedValue(null);
    const tStart = Date.now();
    await fetchWithRetry(fn); // pas de opts → defaults
    const elapsed = Date.now() - tStart;
    expect(fn).toHaveBeenCalledTimes(3);
    // Default backoff = 250ms × 2 (entre attempts) = 500ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(450); // tolérance scheduler
  });

  it('returns null when all attempts throw exceptions', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    const result = await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats undefined return as failure (retries)', async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    await fetchWithRetry(fn, { maxAttempts: 3, backoffMs: 1, timeoutMs: 1500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
