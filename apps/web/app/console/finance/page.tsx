'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { InvoiceStatusBadge, UsageMeter } from '@/components/finance/badges';
import { Button, Card, Empty, ErrorText, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { dateInputToIso, money2 } from '@/lib/format';
import type { InvoiceList, Paged, SubscriptionRow } from '@/lib/types';

const DEV_AS_OF = process.env.NODE_ENV !== 'production';

/** Sum amounts per currency; amounts are decimal strings, so sum in cents. */
function byCurrency(rows: { currency: string; amount: string }[]) {
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.currency, (totals.get(r.currency) ?? 0) + Math.round(Number(r.amount) * 100));
  }
  return [...totals].map(([currency, cents]) => ({ currency, total: (cents / 100).toFixed(2) }));
}

function Metric({ label, values }: { label: string; values: string[] }) {
  return (
    <Card>
      <p className="text-sm text-muted">{label}</p>
      {values.length === 0 && <p className="mt-1 text-2xl font-semibold text-ink">—</p>}
      {values.map((v) => (
        <p key={v} className="mt-1 text-2xl font-semibold tabular-nums text-ink">
          {v}
        </p>
      ))}
    </Card>
  );
}

export default function FinanceOverviewPage() {
  const canRun = useCan('invoices:create');
  const qc = useQueryClient();
  const subs = useQuery({
    queryKey: ['subscriptions', 'all'],
    queryFn: () => api<Paged<SubscriptionRow>>('/subscriptions?limit=500'),
  });
  const recent = useQuery({
    queryKey: ['invoices', { limit: 8 }],
    queryFn: () => api<InvoiceList>('/invoices?limit=8'),
  });
  const overdue = useQuery({
    queryKey: ['invoices', { status: 'overdue', limit: 1 }],
    queryFn: () => api<InvoiceList>('/invoices?status=overdue&limit=1'),
  });

  // Outside production a run can simulate a later date (the API refuses asOf in production).
  const [asOf, setAsOf] = useState('');
  const runBody = () => (DEV_AS_OF && asOf ? { asOf: dateInputToIso(asOf)! } : {});
  const runInvoicing = useMutation({
    mutationFn: () =>
      api<{ invoiceIds: string[]; periodsClosed: number; canceled: number }>(
        '/billing/run-invoicing',
        { method: 'POST', body: runBody() },
      ),
    onSuccess: () => qc.invalidateQueries(),
  });
  const runDunning = useMutation({
    mutationFn: () =>
      api<{ remindersSent: number; markedOverdue: number }>('/billing/run-dunning', {
        method: 'POST',
        body: runBody(),
      }),
    onSuccess: () => qc.invalidateQueries(),
  });

  const live = subs.data?.items.filter((s) => s.status !== 'canceled') ?? [];
  const mrr = byCurrency(
    live.map((s) => ({ currency: s.plan.currency, amount: s.plan.priceMonthly })),
  );
  const nearLimit = live
    .filter((s) => (s.usage?.percentUsed ?? 0) >= 80)
    .sort((a, b) => (b.usage?.percentUsed ?? 0) - (a.usage?.percentUsed ?? 0));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Finance</h1>
      <ErrorText error={subs.error ?? recent.error ?? overdue.error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="MRR" values={mrr.map((m) => money2(m.total, m.currency))} />
        <Metric
          label="Outstanding"
          values={(recent.data?.outstanding ?? []).map(
            (o) => `${money2(o.total, o.currency)} (${o.count})`,
          )}
        />
        <Metric
          label="Overdue invoices"
          values={overdue.data ? [String(overdue.data.total)] : []}
        />
        <Metric label="Active subscriptions" values={subs.data ? [String(live.length)] : []} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-ink">Recent invoices</h2>
            <Link
              href="/console/finance/invoices"
              className="text-sm text-brand-700 hover:underline"
            >
              All invoices
            </Link>
          </div>
          {recent.data?.items.length === 0 && <Empty>No invoices yet.</Empty>}
          <ul className="mt-3 divide-y divide-line text-sm">
            {recent.data?.items.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 py-2">
                <Link
                  href={`/console/finance/invoices/${inv.id}`}
                  className="w-36 font-medium text-brand-700 hover:underline"
                >
                  {inv.number}
                </Link>
                <span className="flex-1 truncate">{inv.organization?.name}</span>
                <InvoiceStatusBadge status={inv.status} />
                <span className="w-28 text-right tabular-nums">
                  {money2(inv.total, inv.currency)}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Near or over the plan limit</h2>
          {subs.data && nearLimit.length === 0 && (
            <Empty>Every firm is under 80% of its pages.</Empty>
          )}
          <ul className="mt-3 space-y-3 text-sm">
            {nearLimit.map((s) => (
              <li key={s.id}>
                <p className="font-medium text-ink">
                  {s.organization?.name} <span className="text-muted">· {s.plan.name}</span>
                </p>
                <UsageMeter usage={s.usage} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {canRun && (
        <Card>
          <h2 className="text-base font-semibold text-ink">Billing runs</h2>
          <p className="mt-1 text-sm text-muted">
            The worker runs both jobs daily. Run them now to close finished periods (plan fee +
            overage) or send due-date reminders. Re-running never bills a period twice.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {DEV_AS_OF && (
              <label className="flex items-center gap-2 text-sm text-muted">
                As of (dev only)
                <Input
                  type="date"
                  className="w-40"
                  value={asOf}
                  onChange={(e) => setAsOf(e.target.value)}
                />
              </label>
            )}
            <Button onClick={() => runInvoicing.mutate()} disabled={runInvoicing.isPending}>
              Run monthly invoicing
            </Button>
            <Button
              variant="secondary"
              onClick={() => runDunning.mutate()}
              disabled={runDunning.isPending}
            >
              Run dunning
            </Button>
            <p role="status" className="text-sm text-body">
              {runInvoicing.data &&
                `Invoicing: ${runInvoicing.data.invoiceIds.length} invoice(s) issued, ${runInvoicing.data.periodsClosed} period(s) closed, ${runInvoicing.data.canceled} subscription(s) ended.`}{' '}
              {runDunning.data &&
                `Dunning: ${runDunning.data.remindersSent} reminder(s) sent, ${runDunning.data.markedOverdue} marked overdue.`}
            </p>
          </div>
          <ErrorText error={runInvoicing.error ?? runDunning.error} />
        </Card>
      )}

      <p className="text-xs text-muted">Amounts are shown per currency; nothing is converted.</p>
    </div>
  );
}
