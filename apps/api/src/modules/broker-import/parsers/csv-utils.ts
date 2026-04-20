/**
 * Minimal CSV parser — handles quoted fields, escaped quotes, comma or semicolon separators.
 * Not a full RFC-4180 implementation but covers broker exports reliably enough.
 */
export function parseCsv(
  input: string,
  separator?: ',' | ';' | '\t',
): string[][] {
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sep = separator ?? detectSeparator(text);

  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === sep) {
        current.push(field);
        field = '';
      } else if (c === '\n') {
        current.push(field);
        field = '';
        rows.push(current);
        current = [];
      } else {
        field += c;
      }
    }
  }
  // Flush final field/row
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }

  // Drop trailing empty rows
  while (rows.length > 0 && rows[rows.length - 1].every((f) => f.trim() === '')) {
    rows.pop();
  }
  return rows;
}

function detectSeparator(text: string): ',' | ';' | '\t' {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  if (tabs >= commas && tabs >= semicolons && tabs > 0) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

/** Convert a locale-formatted number string (1.234,56 or 1,234.56) to decimal string. */
export function parseLocaleNumber(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const s = raw.trim();
  if (s === '' || s === '-') return null;

  // Remove spaces (thousands separator in some locales)
  const cleaned = s.replace(/\s/g, '');

  // Detect decimal separator: if last ',' is after last '.', comma is decimal
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized: string;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = cleaned.replace(/,/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return normalized;
}

/** Parse various date formats → YYYY-MM-DD ISO date, or null. */
export function parseFlexibleDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s === '') return null;

  // ISO 8601 (YYYY-MM-DD or with time)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // DD/MM/YYYY or DD-MM-YYYY
  const euMatch = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (euMatch) return `${euMatch[3]}-${euMatch[2]}-${euMatch[1]}`;

  // MM/DD/YYYY (US) — ambiguous; fall back to Date.parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}
