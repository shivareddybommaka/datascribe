'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { SubscriptionStatusBadge, UsageMeter } from '@/components/finance/badges';
import { Button, Dialog, Empty, ErrorText, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money2 } from '@/lib/format';
import type { Paged, Plan, SubscriptionRow } from '@/lib/types';

export default function SubscriptionsPage() {
  const canManage = useCan('subscriptions:manage');
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const canAddUsage = useCan('subscriptions:edit');
  const [changing, setChanging] = useState<SubscriptionRow | null>(null);
  const [addingUsage, setAddingUsage] = useState<SubscriptionRow | null>(null);
  const subs = useQuery({
    queryKey: ['subscriptions', status || 'all'],
    queryFn: () =>
      api<Paged<SubscriptionRow>>(`/subscriptions?limit=500${status ? `&status=${status}` : ''}`),
  });
  const cancel = useMutation({
    mutationFn: (s: SubscriptionRow) =>
      api('/subscriptions/cancel', {
        method: 'POST',
        body: { organizationId: s.organizationId, cancelAtPeriodEnd: !s.cancelAtPeriodEnd },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subscriptions'] }),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Subscriptions</h1>
        <Select
          aria-label="Status"
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Any status</option>
          {['active', 'trialing', 'past_due', 'canceled'].map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
      </div>
      <ErrorText error={subs.error ?? cancel.error} />
      {subs.data?.items.length === 0 && <Empty>No subscriptions.</Empty>}
      {!!subs.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Client', 'Plan', 'Status', 'Period', 'Usage this period', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {subs.data.items.map((s) => (
                <tr key={s.id} className="align-top hover:bg-surface">
                  <td className="px-3 py-2">
                    <Link
                      href={`/console/crm/accounts/${s.organizationId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {s.organization?.name ?? s.organizationId}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {s.plan.name}
                    <p className="text-xs text-muted">
                      {money2(s.plan.priceMonthly, s.plan.currency)}/mo
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <SubscriptionStatusBadge sub={s} />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {date(s.currentPeriodStart)} – {date(s.currentPeriodEnd)}
                  </td>
                  <td className="px-3 py-2">
                    <UsageMeter usage={s.usage} />
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {canManage && s.status !== 'canceled' && (
                      <span className="inline-flex gap-2">
                        {canAddUsage && (
                          <Button variant="secondary" size="sm" onClick={() => setAddingUsage(s)}>
                            Add usage
                          </Button>
                        )}
                        <Button variant="secondary" size="sm" onClick={() => setChanging(s)}>
                          Change plan
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(s)}
                        >
                          {s.cancelAtPeriodEnd ? 'Resume' : 'Cancel at period end'}
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {changing && <ChangePlanDialog sub={changing} onClose={() => setChanging(null)} />}
      {addingUsage && <UsageDialog sub={addingUsage} onClose={() => setAddingUsage(null)} />}
    </div>
  );
}

/** Finance: manual page count (corrections, work done outside the pipeline). D-040. */
function UsageDialog({ sub, onClose }: { sub: SubscriptionRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [pages, setPages] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api('/usage', {
        method: 'POST',
        body: { organizationId: sub.organizationId, pages: Number(pages) },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['subscriptions'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Add usage — ${sub.organization?.name ?? ''}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Pages processed" htmlFor="usage-pages">
          <Input
            id="usage-pages"
            type="number"
            min={1}
            max={1_000_000}
            required
            value={pages}
            onChange={(e) => setPages(e.target.value)}
          />
        </Field>
        <p className="text-sm text-muted">
          Counted in the current period. Case deliveries record their pages automatically; use this
          for corrections only.
        </p>
        <ErrorText error={add.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={add.isPending || !pages}>
            Add pages
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangePlanDialog({ sub, onClose }: { sub: SubscriptionRow; onClose: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ['plans', 'active'],
    queryFn: () => api<{ items: Plan[] }>('/plans'),
  });
  const [planId, setPlanId] = useState(sub.plan.id);
  const change = useMutation({
    mutationFn: () =>
      api('/subscriptions/change', {
        method: 'POST',
        body: { organizationId: sub.organizationId, planId },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['subscriptions'] });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Change plan — ${sub.organization?.name ?? ''}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Field label="Plan" htmlFor="change-plan">
          <Select id="change-plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
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
        <p className="text-sm text-muted">
          Takes effect now. The period invoice uses the plan in force when the period ends (no
          proration). Changing plan also clears a pending cancellation.
        </p>
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
