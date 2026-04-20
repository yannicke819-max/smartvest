import { parseCsv, parseLocaleNumber, parseFlexibleDate } from '../csv-utils';

describe('parseCsv', () => {
  it('parses basic comma-separated rows', () => {
    const rows = parseCsv('a,b,c\n1,2,3');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsv('a,"b,c",d');
    expect(rows[0]).toEqual(['a', 'b,c', 'd']);
  });

  it('handles escaped double quotes', () => {
    const rows = parseCsv('a,"he said ""hi""",b');
    expect(rows[0][1]).toBe('he said "hi"');
  });

  it('detects semicolon separator', () => {
    const rows = parseCsv('a;b;c\n1;2;3');
    expect(rows[1]).toEqual(['1', '2', '3']);
  });

  it('drops trailing empty rows', () => {
    const rows = parseCsv('a,b\n1,2\n\n');
    expect(rows.length).toBe(2);
  });
});

describe('parseLocaleNumber', () => {
  it('parses plain integers', () => expect(parseLocaleNumber('42')).toBe('42'));
  it('parses US format with thousands', () => expect(parseLocaleNumber('1,234.56')).toBe('1234.56'));
  it('parses EU format with comma decimal', () => expect(parseLocaleNumber('1.234,56')).toBe('1234.56'));
  it('returns null for empty', () => expect(parseLocaleNumber('')).toBeNull());
  it('returns null for dash', () => expect(parseLocaleNumber('-')).toBeNull());
  it('returns null for non-numeric', () => expect(parseLocaleNumber('abc')).toBeNull());
  it('handles negative numbers', () => expect(parseLocaleNumber('-42.50')).toBe('-42.50'));
});

describe('parseFlexibleDate', () => {
  it('parses ISO format', () => expect(parseFlexibleDate('2024-03-15')).toBe('2024-03-15'));
  it('parses DD/MM/YYYY', () => expect(parseFlexibleDate('15/03/2024')).toBe('2024-03-15'));
  it('parses DD-MM-YYYY', () => expect(parseFlexibleDate('15-03-2024')).toBe('2024-03-15'));
  it('extracts date from ISO with time', () => expect(parseFlexibleDate('2024-03-15T10:00:00Z')).toBe('2024-03-15'));
  it('returns null for invalid', () => expect(parseFlexibleDate('not a date')).toBeNull());
  it('returns null for empty', () => expect(parseFlexibleDate('')).toBeNull());
});
