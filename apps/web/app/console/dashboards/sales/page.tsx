'use client';

import type { LeadStage } from '@datascribe/shared/constants';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Empty, ErrorText, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { SOURCE_LABEL, STAGE_LABEL, money } from '@/lib/format';

interface SalesDashboard {
  days: number;
  pipeline: { stage: LeadStage; count: number; value: { currency: string; amount: string }[] }[];
  conversion: {
    created: number;
    won: number;
    lost: number;
    rate: number | null;
    winRate: number | null;
  };
  sources: { source: string; count: number }[];
}

const WINDOWS = [30, 90, 365] as const;
const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`;
const amounts = (v: { currency: string; amount: string }[]) =>
  v.length ? v.map((x) => money(x.amount, x.currency)).join(' + ') : '—';

/** §5.9 sales dashboard: pipeline value by stage, conversion rate, leads by source. */
export default function SalesDashboardPage() {
  const [days, setDays] = useState<number>(90);
  const q = useQuery({
    queryKey: ['dashboards', 'sales', days],
    queryFn: () => api<SalesDashboard>(`/dashboards/sales?days=${days}`),
  });
  const d = q.data;
  const maxSource = Math.max(1, ...(d?.sources.map((s) => s.count) ?? []));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Sales dashboard</h1>
        <label className="flex items-center gap-2 text-sm text-muted">
          Leads created in the last
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

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-muted">New leads</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-created">
            {d?.conversion.created ?? '—'}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Conversion (won ÷ new)</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-rate">
            {pct(d?.conversion.rate)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Win rate (won ÷ closed)</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{pct(d?.conversion.winRate)}</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-ink">Pipeline value by stage</h2>
          <p className="text-xs text-muted">All leads, today. Totals are per currency.</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-2 font-medium">Stage</th>
                <th className="py-2 text-right font-medium">Leads</th>
                <th className="py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d?.pipeline.map((row) => (
                <tr key={row.stage}>
                  <td className="py-2">{STAGE_LABEL[row.stage]}</td>
                  <td className="py-2 text-right tabular-nums">{row.count}</td>
                  <td className="py-2 text-right tabular-nums">{amounts(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Leads by source</h2>
          {d && d.sources.length === 0 ? (
            <Empty>No leads in this window.</Empty>
          ) : (
            <ul className="mt-3 space-y-2 text-sm" aria-label="Leads by source">
              {d?.sources.map((s) => (
                <li key={s.source} className="flex items-center gap-3">
                  <span className="w-36 shrink-0 truncate">
                    {SOURCE_LABEL[s.source] ?? s.source}
                  </span>
                  <span className="h-2 flex-1 rounded bg-line">
                    <span
                      className="block h-2 rounded bg-brand-600"
                      style={{ width: `${(s.count / maxSource) * 100}%` }}
                    />
                  </span>
                  <span className="w-10 text-right tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
