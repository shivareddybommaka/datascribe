'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { Badge, Button, Dialog, Empty, ErrorText, Field, Input, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money2 } from '@/lib/format';
import type { Plan } from '@/lib/types';

export default function PlansPage() {
  const canEdit = useCan('subscriptions:edit');
  const canCreate = useCan('subscriptions:create');
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const plans = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: () => api<{ items: Plan[] }>('/plans?includeInactive=true'),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Plans</h1>
        {canCreate && <Button onClick={() => setEditing('new')}>New plan</Button>}
      </div>
      <p className="text-sm text-muted">
        Plans are deactivated, not deleted: subscriptions and invoices keep pointing at them.
      </p>
      <ErrorText error={plans.error} />
      {plans.data?.items.length === 0 && <Empty>No plans yet.</Empty>}
      {!!plans.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {[
                  'Plan',
                  'Monthly',
                  'Included pages',
                  'Overage / page',
                  'Features',
                  'Status',
                  '',
                ].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {plans.data.items.map((p) => (
                <tr key={p.id} className="align-top hover:bg-surface">
                  <td className="px-3 py-2 font-medium text-ink">{p.name}</td>
                  <td className="px-3 py-2 tabular-nums">{money2(p.priceMonthly, p.currency)}</td>
                  <td className="px-3 py-2 tabular-nums">{p.includedPages.toLocaleString()}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {p.currency} {Number(p.overagePerPage)}
                  </td>
                  <td className="px-3 py-2 text-muted">{p.features.join(' · ') || '—'}</td>
                  <td className="px-3 py-2">
                    <Badge tone={p.active ? 'green' : 'neutral'}>
                      {p.active ? 'active' : 'inactive'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <Button variant="secondary" size="sm" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <PlanDialog plan={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function PlanDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: plan?.name ?? '',
    priceMonthly: plan?.priceMonthly ?? '',
    currency: plan?.currency ?? 'USD',
    includedPages: String(plan?.includedPages ?? ''),
    overagePerPage: plan ? String(Number(plan.overagePerPage)) : '',
    features: plan?.features.join('\n') ?? '',
    sortOrder: String(plan?.sortOrder ?? 0),
    active: plan?.active ?? true,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        priceMonthly: form.priceMonthly.trim(),
        currency: form.currency.trim(),
        includedPages: Number(form.includedPages),
        overagePerPage: form.overagePerPage.trim(),
        features: form.features
          .split('\n')
          .map((f) => f.trim())
          .filter(Boolean),
        sortOrder: Number(form.sortOrder),
        active: form.active,
      };
      return plan
        ? api<Plan>(`/plans/${plan.id}`, { method: 'PATCH', body })
        : api<Plan>('/plans', { method: 'POST', body });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['plans'] });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={plan ? `Edit ${plan.name}` : 'New plan'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" htmlFor="plan-name">
          <Input
            id="plan-name"
            required
            maxLength={80}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Monthly price" htmlFor="plan-price">
            <Input
              id="plan-price"
              inputMode="decimal"
              required
              value={form.priceMonthly}
              onChange={(e) => set({ priceMonthly: e.target.value })}
            />
          </Field>
          <Field label="Currency" htmlFor="plan-currency">
            <Input
              id="plan-currency"
              required
              maxLength={3}
              disabled={!!plan}
              value={form.currency}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Sort order" htmlFor="plan-sort">
            <Input
              id="plan-sort"
              type="number"
              min={0}
              max={1000}
              value={form.sortOrder}
              onChange={(e) => set({ sortOrder: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Included pages / month" htmlFor="plan-pages">
            <Input
              id="plan-pages"
              type="number"
              min={0}
              required
              value={form.includedPages}
              onChange={(e) => set({ includedPages: e.target.value })}
            />
          </Field>
          <Field label="Overage price / page" htmlFor="plan-overage">
            <Input
              id="plan-overage"
              inputMode="decimal"
              required
              value={form.overagePerPage}
              onChange={(e) => set({ overagePerPage: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Features (one per line)" htmlFor="plan-features">
          <Textarea
            id="plan-features"
            rows={4}
            value={form.features}
            onChange={(e) => set({ features: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          Active (offered to firms and on the pricing page)
        </label>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {plan ? 'Save plan' : 'Create plan'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
