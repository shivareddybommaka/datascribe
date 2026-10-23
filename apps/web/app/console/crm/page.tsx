'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { MyTasks } from '@/components/my-tasks';
import { Card, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';
import { STAGE_LABEL, money } from '@/lib/format';
import type { PipelineSummary } from '@/lib/types';

export default function CrmOverview() {
  const summary = useQuery({
    queryKey: ['pipeline-summary'],
    queryFn: () => api<PipelineSummary>('/pipeline/summary'),
  });
  const s = summary.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">CRM overview</h1>
        <Link
          href="/console/crm/leads"
          className="text-sm font-medium text-brand-700 hover:underline"
        >
          Go to pipeline →
        </Link>
      </div>
      <ErrorText error={summary.error} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">Open leads</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{s?.openCount ?? '—'}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Open pipeline value</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{s ? money(s.openValue) : '—'}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Win rate (won ÷ closed)</p>
          <p className="mt-1 text-2xl font-semibold text-ink">
            {s?.conversionRate === null || s === undefined
              ? '—'
              : `${Math.round(s.conversionRate * 100)}%`}
          </p>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-ink">Pipeline by stage</h2>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-2 font-medium">Stage</th>
                <th className="py-2 text-right font-medium">Leads</th>
                <th className="py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {s?.byStage.map((row) => (
                <tr key={row.stage}>
                  <td className="py-2">
                    <Link
                      href={`/console/crm/leads?stage=${row.stage}`}
                      className="text-brand-700 hover:underline"
                    >
                      {STAGE_LABEL[row.stage]}
                    </Link>
                  </td>
                  <td className="py-2 text-right tabular-nums">{row.count}</td>
                  <td className="py-2 text-right tabular-nums">{money(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <MyTasks />
      </div>
    </div>
  );
}
