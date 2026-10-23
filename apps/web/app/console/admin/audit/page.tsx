'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ChangeEvent } from 'react';
import { useCan } from '@/components/auth';
import { Badge, Button, Empty, ErrorText, Field, Input } from '@/components/ui';
import { api, downloadCsv } from '@/lib/api';
import type { AuditEntry, Paged } from '@/lib/types';

const PAGE = 50;
const EMPTY = { user: '', action: '', entity: '', entityId: '', from: '', to: '' };

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export default function AuditLogPage() {
  const canExport = useCan('audit_log:export');
  const [draft, setDraft] = useState(EMPTY);
  const [filters, setFilters] = useState(EMPTY);
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v.trim()) params.set(k, v.trim());
  const listParams = new URLSearchParams(params);
  listParams.set('limit', String(PAGE));
  listParams.set('offset', String(offset));

  const logs = useQuery({
    queryKey: ['audit-logs', filters, offset],
    queryFn: () => api<Paged<AuditEntry>>(`/admin/audit-logs?${listParams}`),
    placeholderData: keepPreviousData,
  });
  const exportCsv = useMutation({
    mutationFn: () =>
      downloadCsv(
        `/admin/audit-logs/export?${params}`,
        `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      ),
  });
  const data = logs.data;
  const field = (k: keyof typeof EMPTY) => ({
    value: draft[k],
    onChange: (e: ChangeEvent<HTMLInputElement>) =>
      setDraft((d) => ({ ...d, [k]: e.target.value })),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Audit log</h1>
        {canExport && (
          <Button
            variant="secondary"
            onClick={() => exportCsv.mutate()}
            disabled={exportCsv.isPending}
          >
            Export CSV
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">
        Read-only record of sign-ins, admin actions and record access. Entries can&apos;t be changed
        or deleted.
      </p>

      <form
        role="search"
        aria-label="Filter audit log"
        className="grid gap-3 md:grid-cols-7"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setFilters(draft);
        }}
      >
        <Field label="User (name or email)" htmlFor="f-user" className="md:col-span-2">
          <Input id="f-user" {...field('user')} />
        </Field>
        <Field label="Action starts with" htmlFor="f-action">
          <Input id="f-action" placeholder="admin.role" {...field('action')} />
        </Field>
        <Field label="Entity" htmlFor="f-entity">
          <Input id="f-entity" placeholder="User" {...field('entity')} />
        </Field>
        <Field label="From" htmlFor="f-from">
          <Input id="f-from" type="date" {...field('from')} />
        </Field>
        <Field label="To" htmlFor="f-to">
          <Input id="f-to" type="date" {...field('to')} />
        </Field>
        <div className="flex items-end gap-2">
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(EMPTY);
              setFilters(EMPTY);
              setOffset(0);
            }}
          >
            Clear
          </Button>
        </div>
      </form>

      <ErrorText error={logs.error ?? exportCsv.error} />
      {data?.items.length === 0 && <Empty>No entries match.</Empty>}
      {!!data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['When', 'Action', 'Entity', 'Who', 'Organization', 'IP', 'Details'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((a) => (
                <tr key={a.id} className="align-top hover:bg-surface">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted">
                    {when(a.createdAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink">{a.action}</td>
                  <td className="px-3 py-2">
                    {a.entity}
                    {a.entityId && <div className="font-mono text-xs text-muted">{a.entityId}</div>}
                  </td>
                  <td className="px-3 py-2">
                    {a.actor?.email ?? '—'}
                    {a.impersonator && (
                      <div>
                        <Badge tone="amber">via {a.impersonator.email}</Badge>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{a.organization?.name ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted">{a.ip ?? '—'}</td>
                  <td className="max-w-xs px-3 py-2 font-mono text-xs text-muted">
                    {Object.keys(a.metadata ?? {}).length ? JSON.stringify(a.metadata) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted">
          {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={offset + PAGE >= data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
