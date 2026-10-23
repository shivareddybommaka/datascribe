'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { InvoiceStatusBadge } from '@/components/finance/badges';
import { OneOffInvoiceDialog } from '@/components/finance/one-off-invoice';
import { Button, Empty, ErrorText, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money2 } from '@/lib/format';
import type { InvoiceList } from '@/lib/types';

const PAGE = 50;
const STATUSES = ['issued', 'overdue', 'paid', 'refunded', 'void', 'draft'] as const;

export default function InvoicesPage() {
  const canCreate = useCan('invoices:create');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (kind) params.set('kind', kind);
  const invoices = useQuery({
    queryKey: ['invoices', { q, status, kind, offset }],
    queryFn: () => api<InvoiceList>(`/invoices?${params}`),
    placeholderData: keepPreviousData,
  });
  const data = invoices.data;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Invoices</h1>
        {canCreate && <Button onClick={() => setCreating(true)}>New one-off invoice</Button>}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setQ(String(new FormData(e.currentTarget).get('q') ?? '').trim());
          }}
        >
          <Input
            name="q"
            aria-label="Invoice number"
            placeholder="Invoice number"
            className="w-48"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <Select
          aria-label="Status"
          className="w-36"
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
        >
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Kind"
          className="w-40"
          value={kind}
          onChange={(e) => {
            setOffset(0);
            setKind(e.target.value);
          }}
        >
          <option value="">Any kind</option>
          <option value="subscription">Subscription</option>
          <option value="one_off">One-off</option>
        </Select>
        {!!data?.outstanding.length && (
          <p className="ml-auto text-sm text-muted">
            Outstanding in this view:{' '}
            {data.outstanding.map((o) => (
              <span key={o.currency} className="ml-2 font-medium tabular-nums text-ink">
                {money2(o.total, o.currency)} ({o.count})
              </span>
            ))}
          </p>
        )}
      </div>

      <ErrorText error={invoices.error} />
      {data?.items.length === 0 && <Empty>No invoices match.</Empty>}
      {!!data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Number', 'Client', 'Kind', 'Status', 'Issued', 'Due', 'Total'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className={`px-3 py-2 font-medium ${h === 'Total' ? 'text-right' : ''}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface">
                  <td className="px-3 py-2">
                    <Link
                      href={`/console/finance/invoices/${inv.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {inv.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{inv.organization?.name ?? '—'}</td>
                  <td className="px-3 py-2">
                    {inv.kind === 'one_off' ? 'One-off' : 'Subscription'}
                  </td>
                  <td className="px-3 py-2">
                    <InvoiceStatusBadge status={inv.status} />
                  </td>
                  <td className="px-3 py-2">{date(inv.issuedAt)}</td>
                  <td className="px-3 py-2">{date(inv.dueAt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money2(inv.total, inv.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE && (
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
      {canCreate && <OneOffInvoiceDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}
