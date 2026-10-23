'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { Badge, Button, Dialog, Empty, ErrorText, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money2 } from '@/lib/format';
import type { OrgRow, Paged, Plan } from '@/lib/types';

const PAGE = 100;

export default function OrganizationsPage() {
  const canEdit = useCan('users:edit:all');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('client');
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<OrgRow | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (type) params.set('type', type);
  const orgs = useQuery({
    queryKey: ['admin-orgs', { q, status, type, offset }],
    queryFn: () => api<Paged<OrgRow>>(`/admin/organizations?${params}`),
    placeholderData: keepPreviousData,
  });
  const data = orgs.data;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold text-ink">Organizations</h1>
      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setQ(String(new FormData(e.currentTarget).get('q') ?? '').trim());
          }}
        >
          <Input name="q" aria-label="Search organizations" placeholder="Name" className="w-64" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <Select
          aria-label="Type"
          className="w-40"
          value={type}
          onChange={(e) => {
            setOffset(0);
            setType(e.target.value);
          }}
        >
          <option value="">Any type</option>
          <option value="client">Client firms</option>
          <option value="internal">Datascribe</option>
        </Select>
        <Select
          aria-label="Status"
          className="w-36"
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="closed">Closed</option>
        </Select>
      </div>

      <ErrorText error={orgs.error} />
      {data?.items.length === 0 && <Empty>No organizations match.</Empty>}
      {!!data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Organization', 'Status', 'Plan', 'Users', 'MFA', 'Retention', 'Since', ''].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((o) => (
                <tr key={o.id} className="hover:bg-surface">
                  <td className="px-3 py-2 font-medium text-ink">{o.name}</td>
                  <td className="px-3 py-2">
                    <Badge tone={o.status === 'active' ? 'green' : 'red'}>{o.status}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    {o.plan?.name ?? '—'}
                    {o.customPricing && (
                      <div className="text-xs text-muted">
                        custom: {money2(o.customPricing.priceMonthly, o.currency)}/mo
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{o.userCount}</td>
                  <td className="px-3 py-2">
                    {o.enforceMfa || o.type === 'internal' ? 'required' : 'optional'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{o.retentionDays} days</td>
                  <td className="px-3 py-2 text-muted">{date(o.createdAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={`Edit ${o.name}`}
                        onClick={() => setEditing(o)}
                      >
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
      {editing && <OrgDialog org={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function OrgDialog({ org, onClose }: { org: OrgRow; onClose: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ['plans', 'all'],
    queryFn: () => api<{ items: Plan[] }>('/plans?includeInactive=true'),
  });
  const [form, setForm] = useState({
    name: org.name,
    planId: org.plan?.id ?? '',
    currency: org.currency,
    enforceMfa: org.enforceMfa,
    retentionDays: String(org.retentionDays),
    custom: !!org.customPricing,
    priceMonthly: org.customPricing?.priceMonthly ?? '',
    includedPages: String(org.customPricing?.includedPages ?? ''),
    overagePerPage: org.customPricing?.overagePerPage ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['admin-orgs'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api<OrgRow>(`/admin/organizations/${org.id}`, {
        method: 'PATCH',
        body: {
          name: form.name.trim(),
          planId: form.planId || null,
          currency: form.currency.trim(),
          retentionDays: Number(form.retentionDays),
          ...(org.type === 'client' ? { enforceMfa: form.enforceMfa } : {}),
          customPricing: form.custom
            ? {
                priceMonthly: form.priceMonthly.trim(),
                includedPages: Number(form.includedPages),
                overagePerPage: form.overagePerPage.trim(),
              }
            : null,
        },
      }),
    onSuccess: done,
  });
  const status = useMutation({
    mutationFn: (action: 'suspend' | 'reactivate') =>
      api<OrgRow>(`/admin/organizations/${org.id}/${action}`, { method: 'POST' }),
    onSuccess: done,
  });

  return (
    <Dialog open onClose={onClose} title={`Edit ${org.name}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" htmlFor="org-name">
          <Input
            id="org-name"
            required
            minLength={2}
            maxLength={200}
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Plan" htmlFor="org-plan" className="col-span-2">
            <Select
              id="org-plan"
              value={form.planId}
              onChange={(e) => set({ planId: e.target.value })}
            >
              <option value="">No plan</option>
              {plans.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({money2(p.priceMonthly, p.currency)}/mo{p.active ? '' : ', inactive'})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="org-currency">
            <Input
              id="org-currency"
              required
              maxLength={3}
              value={form.currency}
              onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Retention (days after case closed)" htmlFor="org-retention">
            <Input
              id="org-retention"
              type="number"
              min={30}
              max={3650}
              required
              value={form.retentionDays}
              onChange={(e) => set({ retentionDays: e.target.value })}
            />
          </Field>
          {org.type === 'client' && (
            <label className="mt-6 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={form.enforceMfa}
                onChange={(e) => set({ enforceMfa: e.target.checked })}
              />
              Require two-factor for this firm
            </label>
          )}
        </div>
        <fieldset className="space-y-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium text-ink">Custom pricing</legend>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.custom}
              onChange={(e) => set({ custom: e.target.checked })}
            />
            Override the plan&apos;s price for this firm
          </label>
          {form.custom && (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Monthly fee" htmlFor="org-price">
                <Input
                  id="org-price"
                  inputMode="decimal"
                  required
                  value={form.priceMonthly}
                  onChange={(e) => set({ priceMonthly: e.target.value })}
                />
              </Field>
              <Field label="Included pages" htmlFor="org-pages">
                <Input
                  id="org-pages"
                  type="number"
                  min={0}
                  required
                  value={form.includedPages}
                  onChange={(e) => set({ includedPages: e.target.value })}
                />
              </Field>
              <Field label="Overage / page" htmlFor="org-overage">
                <Input
                  id="org-overage"
                  inputMode="decimal"
                  required
                  value={form.overagePerPage}
                  onChange={(e) => set({ overagePerPage: e.target.value })}
                />
              </Field>
            </div>
          )}
          <p className="text-xs text-muted">Applied by the next monthly invoicing run.</p>
        </fieldset>
        <ErrorText error={save.error ?? status.error} />
        <div className="flex items-center justify-between gap-2">
          {org.type === 'client' &&
            (org.status === 'active' ? (
              <Button
                variant="danger"
                disabled={status.isPending}
                onClick={() => {
                  if (window.confirm(`Suspend ${org.name}? Everyone in it is signed out.`)) {
                    status.mutate('suspend');
                  }
                }}
              >
                Suspend
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={status.isPending}
                onClick={() => status.mutate('reactivate')}
              >
                Reactivate
              </Button>
            ))}
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
