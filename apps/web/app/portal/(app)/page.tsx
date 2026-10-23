'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMe } from '@/components/auth';
import { InvoiceStatusBadge, UsageMeter } from '@/components/finance/badges';
import { CaseStatusBadge, DELIVERABLE_LABEL } from '@/components/portal/labels';
import { Card, Empty, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money2 } from '@/lib/format';
import type { PortalDashboard } from '@/lib/types';

/** §5.3 dashboard: open cases by status, recent deliverables, usage vs plan, outstanding invoices. */
export default function PortalDashboardPage() {
  const me = useMe();
  const dash = useQuery({
    queryKey: ['portal', 'dashboard'],
    queryFn: () => api<PortalDashboard>('/portal/dashboard'),
  });
  if (dash.error) return <ErrorText error={dash.error} />;
  if (!dash.data) return <p className="text-sm text-muted">Loading…</p>;
  const d = dash.data;
  const open = d.openCases.reduce((n, s) => n + s.count, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold text-ink">Dashboard</h1>
        <Link
          href="/portal/cases/new"
          className="ml-auto rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New case
        </Link>
      </div>
      <p className="text-sm text-muted">Welcome back, {me.user.name}.</p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-ink">Open cases</h2>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">{open}</p>
          {d.openCases.length === 0 ? (
            <Empty>No open cases yet.</Empty>
          ) : (
            <ul className="mt-3 space-y-2 text-sm" aria-label="Open cases by status">
              {d.openCases.map((s) => (
                <li key={s.status} className="flex items-center justify-between">
                  <Link href={`/portal/cases?status=${s.status}`} className="hover:underline">
                    <CaseStatusBadge status={s.status} />
                  </Link>
                  <span className="tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Recent deliverables</h2>
          {d.recentDeliverables.length === 0 ? (
            <Empty>Deliverables appear here when Datascribe delivers them.</Empty>
          ) : (
            <ul className="mt-3 divide-y divide-line text-sm">
              {d.recentDeliverables.map((r) => (
                <li key={r.id} className="flex items-center gap-2 py-2">
                  <Link
                    href={`/portal/cases/${r.case.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    {r.case.number}
                  </Link>
                  <span>
                    {DELIVERABLE_LABEL[r.type]} v{r.version}
                  </span>
                  <span className="ml-auto text-muted">{date(r.deliveredAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {d.usage && (
          <Card>
            <h2 className="text-base font-semibold text-ink">Usage this period</h2>
            <p className="mt-1 text-sm text-muted">
              {d.usage.plan.name} · {date(d.usage.periodStart)} – {date(d.usage.periodEnd)}
            </p>
            <div className="mt-3">
              <UsageMeter usage={d.usage} />
            </div>
          </Card>
        )}

        {d.invoices && (
          <Card>
            <h2 className="text-base font-semibold text-ink">Outstanding invoices</h2>
            {d.invoices.items.length === 0 ? (
              <Empty>Nothing to pay.</Empty>
            ) : (
              <>
                <p className="mt-1 text-sm text-muted">
                  {d.invoices.outstanding
                    .map((o) => `${o.count} · ${money2(o.total, o.currency)}`)
                    .join(' · ')}
                </p>
                <ul className="mt-3 divide-y divide-line text-sm">
                  {d.invoices.items.map((inv) => (
                    <li key={inv.id} className="flex items-center gap-3 py-2">
                      <Link
                        href={`/portal/billing/invoices/${inv.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {inv.number}
                      </Link>
                      <InvoiceStatusBadge status={inv.status} />
                      <span className="ml-auto tabular-nums">
                        {money2(inv.total, inv.currency)}
                      </span>
                      <span className="text-muted">due {date(inv.dueAt)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
