'use client';

import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button, Dialog, ErrorText } from '../ui';

interface RowError {
  row: number;
  message: string;
}

/** CSV import dialog for /leads/import or /contacts/import. All-or-nothing on the server (D-018). */
export function CsvImport({
  path,
  columnsHint,
  onImported,
}: {
  path: string;
  columnsHint: string;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [error, setError] = useState<unknown>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setResult(null);
    setRowErrors([]);
    setError(null);
    try {
      const res = await api<{ created: number }>(path, {
        method: 'POST',
        body: await file.text(),
        contentType: 'text/csv',
      });
      setResult(`Imported ${res.created} row(s).`);
      onImported();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        setRowErrors((e.body as { errors: RowError[] }).errors);
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Import CSV
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Import CSV">
        <div className="space-y-4 text-sm">
          <p className="text-body">
            Columns (header row, any order):{' '}
            <code className="font-mono text-ink">{columnsHint}</code>. If any row is invalid,
            nothing is imported.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            disabled={busy}
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {busy && <p className="text-muted">Importing…</p>}
          {result && (
            <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-green-900">
              {result}
            </p>
          )}
          <ErrorText error={error} />
          {rowErrors.length > 0 && (
            <ul className="max-h-48 overflow-auto rounded-md border border-line p-3 text-xs">
              {rowErrors.map((r) => (
                <li key={`${r.row}-${r.message}`}>
                  Row {r.row}: {r.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}
