import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, parseCsvRows, toCsv } from './csv';

describe('parseCsvRows', () => {
  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    const rows = parseCsvRows('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });

  it('strips a BOM, keeps empty cells and drops blank lines', () => {
    expect(parseCsvRows('﻿a,b\n\n1,\n')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('parses a last line without a trailing newline', () => {
    expect(parseCsvRows('a\n1')).toEqual([['a'], ['1']]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsvRows('a\n"oops')).toThrow(/Unterminated/);
  });
});

describe('parseCsv', () => {
  it('maps headers case-insensitively to canonical names and trims values', () => {
    const { headers, rows } = parseCsv('CompanyName , EMAIL\n  Acme , a@x.example \n', [
      'companyName',
      'email',
    ]);
    expect(headers).toEqual(['companyName', 'email']);
    expect(rows).toEqual([{ companyName: 'Acme', email: 'a@x.example' }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('', ['a'])).toEqual({ headers: [], rows: [] });
  });
});

describe('toCsv', () => {
  it('quotes when needed and round-trips', () => {
    const csv = toCsv(['name', 'note'], [{ name: 'A, B', note: 'he said "x"' }]);
    expect(csv).toBe('name,note\r\n"A, B","he said ""x"""\r\n');
    expect(parseCsvRows(csv)).toEqual([
      ['name', 'note'],
      ['A, B', 'he said "x"'],
    ]);
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+61 2 5550 0000')).toBe("'+61 2 5550 0000");
    expect(csvCell('-1')).toBe("'-1");
  });

  it('renders null/undefined as empty and dates as ISO', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });
});
