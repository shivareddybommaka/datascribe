'use client';

import type { CaseStatus } from '@datascribe/shared/constants';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CaseStatusBadge } from '@/components/portal/labels';
import { Card, Empty, ErrorText, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money2 } from '@/lib/format';

interface ClientDashboard {
  days: number;
  scope: 'firm' | 'own' | null;
  cases: { total: number; byStatus: { status: CaseStatus; count: number }[] } | null;
  pages: { processed: number; cases: number } | null;
  spend: { currency: string; amount: string; payments: number }[] | null;
}

const WINDOWS = [30, 90, 365] as const;

/** §5.9 client dashboard: cases by status, pages processed, spend (D-095). */
export default function PortalReportsPage() {
  const [days, setDays] = useState<number>(30);
  const q = useQuery({
    queryKey: ['dashboards', 'client', days],
    queryFn: () => api<ClientDashboard>(`/dashboards/client?days=${days}`),
  });
  const d = q.data;
  const statuses = d?.cases?.byStatus.filter((s) => s.count > 0) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Reports</h1>
        <label className="flex items-center gap-2 text-sm text-muted">
          Activity over the last
          <Select
            aria-label="Window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-auto"
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} days
              </option>
            ))}
          </Select>
        </label>
      </div>
      <ErrorText error={q.error} />
      {d?.scope === 'own' && (
        <p className="text-sm text-muted">
          Counts cover the cases you created or that are shared with you.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {d?.cases && (
          <Card>
            <p className="text-sm text-muted">Cases</p>
            <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-cases">
              {d.cases.total}
            </p>
            <p className="text-xs text-muted">All time</p>
          </Card>
        )}
        {d?.pages && (
          <Card>
            <p className="text-sm text-muted">Pages processed</p>
            <p
              className="mt-1 text-2xl font-semibold tabular-nums text-ink"
              data-testid="kpi-pages"
            >
              {d.pages.processed.toLocaleString('en-US')}
            </p>
            <p className="text-xs text-muted">Counted once per case, when it is first delivered</p>
          </Card>
        )}
        {d?.spend && (
          <Card>
            <p className="text-sm text-muted">Spend</p>
            <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-spend">
              {d.spend.length ? d.spend.map((s) => money2(s.amount, s.currency)).join(' + ') : '—'}
            </p>
            <p className="text-xs text-muted">Paid invoices, net of refunds</p>
          </Card>
        )}
      </div>

      {d?.cases && (
        <Card>
          <h2 className="text-base font-semibold text-ink">Cases by status</h2>
          {statuses.length === 0 ? (
            <Empty>No cases yet.</Empty>
          ) : (
            <ul className="mt-3 divide-y divide-line text-sm" aria-label="Cases by status">
              {statuses.map((s) => (
                <li key={s.status} className="flex items-center justify-between py-2">
                  <CaseStatusBadge status={s.status} />
                  <span className="tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
