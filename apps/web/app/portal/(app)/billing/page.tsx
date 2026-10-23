'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import {
  InvoiceStatusBadge,
  SubscriptionStatusBadge,
  UsageMeter,
} from '@/components/finance/badges';
import { Button, Card, Dialog, Empty, ErrorText, Field, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money2 } from '@/lib/format';
import type { InvoiceList, Plan, SubscriptionRow, Usage } from '@/lib/types';

interface Current {
  organization: { id: string; name: string; currency: string };
  subscription: SubscriptionRow | null;
  usage: Usage | null;
}

/** §5.3 portal billing (client_admin): subscription + usage meter, invoices and billing history. */
export default function BillingPage() {
  const canManage = useCan('subscriptions:manage');
  const canSeeSub = useCan('subscriptions:view');
  const qc = useQueryClient();
  const [changing, setChanging] = useState(false);
  const current = useQuery({
    queryKey: ['subscription', 'current'],
    queryFn: () => api<Current>('/subscriptions/current'),
    enabled: canSeeSub,
  });
  const invoices = useQuery({
    queryKey: ['invoices', 'portal'],
    queryFn: () => api<InvoiceList>('/invoices?limit=100'),
  });
  const cancel = useMutation({
    mutationFn: (cancelAtPeriodEnd: boolean) =>
      api('/subscriptions/cancel', { method: 'POST', body: { cancelAtPeriodEnd } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subscription'] }),
  });

  const sub = current.data?.subscription;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Billing</h1>

      {canSeeSub && (
        <Card>
          <h2 className="text-base font-semibold text-ink">Subscription</h2>
          <ErrorText error={current.error ?? cancel.error} />
          {current.data && !sub && <Empty>No active subscription. Contact Datascribe.</Empty>}
          {sub && (
            <div className="mt-3 flex flex-wrap items-start gap-6">
              <div>
                <p className="text-lg font-semibold text-ink">
                  {sub.plan.name} <SubscriptionStatusBadge sub={sub} />
                </p>
                <p className="text-sm text-muted">
                  {money2(sub.plan.priceMonthly, sub.plan.currency)}/month ·{' '}
                  {sub.plan.includedPages.toLocaleString()} pages included, then{' '}
                  {money2(sub.plan.overagePerPage, sub.plan.currency)} a page
                </p>
                <p className="text-sm text-muted">
                  Current period {date(sub.currentPeriodStart)} – {date(sub.currentPeriodEnd)}
                  {sub.cancelAtPeriodEnd && ` · ends ${date(sub.currentPeriodEnd)}`}
                </p>
              </div>
              <div className="w-64">
                <UsageMeter usage={current.data?.usage} />
              </div>
              {canManage && (
                <div className="ml-auto flex gap-2">
                  <Button variant="secondary" onClick={() => setChanging(true)}>
                    Change plan
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={cancel.isPending}
                    onClick={() => cancel.mutate(!sub.cancelAtPeriodEnd)}
                  >
                    {sub.cancelAtPeriodEnd ? 'Keep subscription' : 'Cancel at period end'}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      <Card className="p-0">
        <h2 className="px-5 pt-5 text-base font-semibold text-ink">Invoices</h2>
        <ErrorText error={invoices.error} />
        {invoices.data?.items.length === 0 && <Empty>No invoices yet.</Empty>}
        {!!invoices.data?.items.length && (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Invoice', 'Status', 'Issued', 'Due', 'Paid', 'Total'].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoices.data.items.map((inv) => (
                <tr key={inv.id} className="hover:bg-surface">
                  <td className="px-4 py-2">
                    <Link
                      href={`/portal/billing/invoices/${inv.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {inv.number}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <InvoiceStatusBadge status={inv.status} />
                  </td>
                  <td className="px-4 py-2">{date(inv.issuedAt)}</td>
                  <td className="px-4 py-2">{date(inv.dueAt)}</td>
                  <td className="px-4 py-2">{date(inv.paidAt)}</td>
                  <td className="px-4 py-2 tabular-nums">{money2(inv.total, inv.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {changing && sub && <ChangePlanDialog sub={sub} onClose={() => setChanging(false)} />}
    </div>
  );
}

function ChangePlanDialog({ sub, onClose }: { sub: SubscriptionRow; onClose: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api<{ items: Plan[] }>('/plans') });
  const [planId, setPlanId] = useState(sub.plan.id);
  const change = useMutation({
    mutationFn: () => api('/subscriptions/change', { method: 'POST', body: { planId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['subscription'] });
      onClose();
    },
  });
  const chosen = plans.data?.items.find((p) => p.id === planId);
  return (
    <Dialog open onClose={onClose} title="Change plan">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Plan" htmlFor="portal-plan">
          <Select id="portal-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            {plans.data?.items
              .filter((p) => p.currency === sub.plan.currency)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {money2(p.priceMonthly, p.currency)}/mo,{' '}
                  {p.includedPages.toLocaleString()} pages
                </option>
              ))}
          </Select>
        </Field>
        {chosen && chosen.id !== sub.plan.id && (
          <p className="text-sm text-body">
            {Number(chosen.priceMonthly) > Number(sub.plan.priceMonthly) ? 'Upgrade' : 'Downgrade'}{' '}
            to {chosen.name}. It takes effect now; this period&apos;s invoice uses the plan in force
            when the period ends (no proration).
          </p>
        )}
        <ErrorText error={plans.error ?? change.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={change.isPending || planId === sub.plan.id}>
            Change plan
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
