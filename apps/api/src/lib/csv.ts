/**
 * Minimal RFC 4180 CSV (CRM import/export). No dependency: the needs are small and well-defined.
 * - parseCsv: quoted fields, escaped quotes (""), CRLF/LF, BOM; returns header-keyed rows.
 * - toCsv: quotes when needed and neutralises spreadsheet formula injection (=, +, -, @, tab, CR).
 */

export function parseCsvRows(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  if (inQuotes) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop fully blank lines
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/** Header names are trimmed and matched case-insensitively against `known` (returned in canonical case). */
export function parseCsv(input: string, known: readonly string[]): ParsedCsv {
  const [head, ...body] = parseCsvRows(input);
  if (!head) return { headers: [], rows: [] };
  const canonical = new Map(known.map((k) => [k.toLowerCase(), k]));
  const headers = head.map((h) => canonical.get(h.trim().toLowerCase()) ?? h.trim());
  const rows = body.map((cells) => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => {
      rec[h] = (cells[idx] ?? '').trim();
    });
    return rec;
  });
  return { headers, rows };
}

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: readonly string[], rows: Record<string, unknown>[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}
