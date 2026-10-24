'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, Empty, ErrorText, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { money } from '@/lib/format';

interface Money {
  currency: string;
  amount: string;
}
interface FinanceDashboard {
  days: number;
  mrr: (Money & { subscriptions: number })[];
  subscriptions: { status: 'trialing' | 'active' | 'past_due' | 'canceled'; count: number }[];
  outstanding: (Money & { count: number })[];
  overdue: (Money & { count: number })[];
  revenue: {
    total: Money[];
    byClient: (Money & { organizationId: string | null; name: string | null; payments: number })[];
  };
}

const WINDOWS = [30, 90, 365] as const;
const SUB_LABEL = {
  trialing: 'Trialing',
  active: 'Active',
  past_due: 'Past due',
  canceled: 'Canceled',
} as const;
const amounts = (v: Money[] | undefined) =>
  v?.length ? v.map((x) => money(x.amount, x.currency)).join(' + ') : '—';
const count = (v: { count: number }[] | undefined) => v?.reduce((n, x) => n + x.count, 0) ?? 0;

/** §5.9 finance dashboard: MRR, invoices outstanding, revenue by client (D-094). */
export default function FinanceDashboardPage() {
  const [days, setDays] = useState<number>(90);
  const q = useQuery({
    queryKey: ['dashboards', 'finance', days],
    queryFn: () => api<FinanceDashboard>(`/dashboards/finance?days=${days}`),
  });
  const d = q.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">Finance dashboard</h1>
        <label className="flex items-center gap-2 text-sm text-muted">
          Revenue over the last
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
          <p className="text-sm text-muted">MRR</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-mrr">
            {amounts(d?.mrr)}
          </p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Outstanding</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-outstanding">
            {amounts(d?.outstanding)}
          </p>
          <p className="text-xs text-muted">{count(d?.outstanding)} invoices</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Overdue</p>
          <p className="mt-1 text-2xl font-semibold text-ink">{amounts(d?.overdue)}</p>
          <p className="text-xs text-muted">{count(d?.overdue)} invoices</p>
        </Card>
        <Card>
          <p className="text-sm text-muted">Revenue</p>
          <p className="mt-1 text-2xl font-semibold text-ink" data-testid="kpi-revenue">
            {amounts(d?.revenue.total)}
          </p>
          <p className="text-xs text-muted">Net of refunds</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="text-base font-semibold text-ink">Revenue by client</h2>
          <p className="text-xs text-muted">
            Top ten per currency, by invoices paid in the window.
          </p>
          {d && d.revenue.byClient.length === 0 ? (
            <Empty>No payments in this window.</Empty>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-2 font-medium">Client</th>
                  <th className="py-2 text-right font-medium">Payments</th>
                  <th className="py-2 text-right font-medium">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d?.revenue.byClient.map((c) => (
                  <tr key={`${c.currency}-${c.organizationId ?? 'other'}`}>
                    <td className="py-2">
                      {c.organizationId ? (c.name ?? 'Unknown client') : 'Other clients'}
                    </td>
                    <td className="py-2 text-right tabular-nums">{c.payments}</td>
                    <td className="py-2 text-right tabular-nums">{money(c.amount, c.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Subscriptions</h2>
          <ul className="mt-3 divide-y divide-line text-sm" aria-label="Subscriptions by status">
            {d?.subscriptions.map((s) => (
              <li key={s.status} className="flex justify-between py-2">
                <span>{SUB_LABEL[s.status]}</span>
                <span className="tabular-nums">{s.count}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
