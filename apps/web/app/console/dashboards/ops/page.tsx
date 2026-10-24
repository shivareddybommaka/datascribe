'use client';

import type { CaseStatus } from '@datascribe/shared/constants';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CASE_STATUS_LABEL } from '@/components/portal/labels';
import { Card, Empty, ErrorText, Select } from '@/components/ui';
import { api } from '@/lib/api';

interface Span {
  count: number;
  avgHours: number | null;
}
interface OpsDashboard {
  days: number;
  scope: 'all' | 'assigned' | 'own';
  byStatus: { status: CaseStatus; count: number }[];
  open: number;
  overdue: number;
  turnaround: { delivered: Span; inReview: Span };
  workload: { userId: string | null; name: string | null; open: number; overdue: number }[];
}

const WINDOWS = [7, 30, 90] as const;
const SCOPE_LABEL = {
  all: 'All cases',
  assigned: 'Cases you manage or work on',
  own: 'Cases you summarize or review',
} as const;
const duration = (h: number | null | undefined) =>
  h === null || h === undefined ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h} h`;

/** §5.9 ops dashboard: cases by status, turnaround, overdue, workload per summarizer (D-093). */
export default function OpsDashboardPage() {
  const [days, setDays] = useState<number>(30);
  const q = useQuery({
    queryKey: ['dashboards', 'ops', days],
    queryFn: () => api<OpsDashboard>(`/dashboards/ops?days=${days}`),
  });
  const d = q.data;
  const statuses = d?.byStatus.filter((s) => s.count > 0) ?? [];
  const maxStatus = Math.max(1, ...statuses.map((s) => s.count));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Operations dashboard</h1>
          {d && (
            <p className="text-sm text-muted" data-testid="ops-scope">
              {SCOPE_LABEL[d.scope]}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted">
          Turnaround over the last
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-sm text-muted">Open cases</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-open">
            {d?.open ?? '—'}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Overdue</p>
          <p
            className={`mt-1 text-2xl font-semibold ${d?.overdue ? 'text-red-700' : 'text-ink'}`}
            data-testid="kpi-overdue"
          >
            {d?.overdue ?? '—'}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Submitted → in review</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {duration(d?.turnaround.inReview.avgHours)}
          </p>
          <p className="text-xs text-muted">{d?.turnaround.inReview.count ?? 0} cases</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Submitted → delivered</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-delivered">
            {duration(d?.turnaround.delivered.avgHours)}
          </p>
          <p className="text-xs text-muted">{d?.turnaround.delivered.count ?? 0} cases</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-ink">Cases by status</h2>
          {d && statuses.length === 0 ? (
            <Empty>No cases yet.</Empty>
          ) : (
            <ul className="mt-3 space-y-2 text-sm" aria-label="Cases by status">
              {statuses.map((s) => (
                <li key={s.status} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate">{CASE_STATUS_LABEL[s.status]}</span>
                  <span className="h-2 flex-1 rounded bg-line">
                    <span
                      className="block h-2 rounded bg-brand-600"
                      style={{ width: `${(s.count / maxStatus) * 100}%` }}
                    />
                  </span>
                  <span className="w-10 text-right tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Workload per summarizer</h2>
          <p className="text-xs text-muted">Open cases, today.</p>
          {d && d.workload.length === 0 ? (
            <Empty>No open cases to summarize.</Empty>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 font-medium">Summarizer</th>
                  <th className="py-2 text-right font-medium">Open</th>
                  <th className="py-2 text-right font-medium">Overdue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d?.workload.map((w) => (
                  <tr key={w.userId ?? 'unassigned'}>
                    <td className="py-2">{w.name ?? (w.userId ? 'Former user' : 'Unassigned')}</td>
                    <td className="py-2 text-right tabular-nums">{w.open}</td>
                    <td className="py-2 text-right tabular-nums">{w.overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}
