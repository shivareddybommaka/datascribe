'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { EmailTemplate, MedicalStatus } from '@/lib/types';

interface Company {
  name: string;
  address: string;
  email: string;
  taxId: string;
  taxLabel: string;
  taxRatePercent: number;
  taxByCurrency: Record<string, { label: string; ratePercent: number }>;
  invoicePrefix: string;
  paymentTermsDays: number;
}
interface Sla {
  turnaroundDays: Record<'urgent' | 'high' | 'normal' | 'low', number>;
  dueSoonHours: number;
}
interface Settings {
  company: Company;
  sla: Sla;
  notifications: { rules: Record<string, { email: boolean; inApp: boolean }> };
  notificationEvents: string[];
  medical: MedicalStatus;
}

const EVENT_LABEL: Record<string, string> = {
  case_submitted: 'Case submitted',
  processing_complete: 'Processing complete',
  assigned_to_you: 'Assigned to you',
  qa_changes_requested: 'QA changes requested',
  approved: 'Deliverable approved',
  delivered: 'Case delivered',
  invoice_issued: 'Invoice issued',
  payment_received: 'Payment received',
  payment_failed: 'Payment failed',
  lead_assigned: 'Lead assigned',
  task_due: 'Task due',
};

export default function SettingsPage() {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<Settings>('/admin/settings'),
  });
  if (settings.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (settings.error) return <ErrorText error={settings.error} />;
  const s = settings.data;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Settings</h1>
      <CompanyCard value={s.company} />
      <SlaCard value={s.sla} />
      <NotificationsCard value={s.notifications.rules} events={s.notificationEvents} />
      <TemplatesCard />
      <MedicalCard value={s.medical} />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-4 text-lg font-semibold text-ink">{title}</h2>
      {children}
    </Card>
  );
}

/** Save one settings section and show the result. */
function useSave<T>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => api<T>(path, { method: 'PUT', body: body as Record<string, unknown> }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
}

function Saved({ show }: { show: boolean }) {
  return show ? (
    <p role="status" className="text-sm text-green-800">
      Saved.
    </p>
  ) : null;
}

function CompanyCard({ value }: { value: Company }) {
  const [form, setForm] = useState({
    ...value,
    taxRatePercent: String(value.taxRatePercent),
    paymentTermsDays: String(value.paymentTermsDays),
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useSave<Company>('/admin/settings/company');
  return (
    <Section title="Company and invoices">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            ...form,
            taxRatePercent: Number(form.taxRatePercent),
            paymentTermsDays: Number(form.paymentTermsDays),
          });
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Company name" htmlFor="co-name">
            <Input
              id="co-name"
              required
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Billing email" htmlFor="co-email">
            <Input
              id="co-email"
              type="email"
              value={form.email}
              onChange={(e) => set({ email: e.target.value })}
            />
          </Field>
          <Field label="Address" htmlFor="co-address">
            <Textarea
              id="co-address"
              rows={2}
              value={form.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </Field>
          <Field label="Tax ID (ABN / GSTIN / EIN)" htmlFor="co-taxid">
            <Input
              id="co-taxid"
              value={form.taxId}
              onChange={(e) => set({ taxId: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Tax label" htmlFor="co-taxlabel">
            <Input
              id="co-taxlabel"
              required
              value={form.taxLabel}
              onChange={(e) => set({ taxLabel: e.target.value })}
            />
          </Field>
          <Field label="Tax rate %" htmlFor="co-taxrate">
            <Input
              id="co-taxrate"
              inputMode="decimal"
              required
              value={form.taxRatePercent}
              onChange={(e) => set({ taxRatePercent: e.target.value })}
            />
          </Field>
          <Field label="Invoice prefix" htmlFor="co-prefix">
            <Input
              id="co-prefix"
              required
              maxLength={10}
              value={form.invoicePrefix}
              onChange={(e) => set({ invoicePrefix: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Payment terms (days)" htmlFor="co-terms">
            <Input
              id="co-terms"
              type="number"
              min={0}
              max={120}
              value={form.paymentTermsDays}
              onChange={(e) => set({ paymentTermsDays: e.target.value })}
            />
          </Field>
        </div>
        {Object.keys(form.taxByCurrency).length > 0 && (
          <p className="text-xs text-muted">
            Per-currency tax:{' '}
            {Object.entries(form.taxByCurrency)
              .map(([c, r]) => `${c} ${r.label} ${r.ratePercent}%`)
              .join(' · ')}
          </p>
        )}
        <ErrorText error={save.error} />
        <Saved show={save.isSuccess} />
        <Button type="submit" disabled={save.isPending}>
          Save company details
        </Button>
      </form>
    </Section>
  );
}

function SlaCard({ value }: { value: Sla }) {
  const [form, setForm] = useState(value);
  const save = useSave<Sla>('/admin/settings/sla');
  return (
    <Section title="SLA defaults">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form);
        }}
      >
        <div className="grid gap-3 md:grid-cols-5">
          {(['urgent', 'high', 'normal', 'low'] as const).map((p) => (
            <Field key={p} label={`Due in (days), ${p}`} htmlFor={`sla-${p}`}>
              <Input
                id={`sla-${p}`}
                type="number"
                min={1}
                max={365}
                value={form.turnaroundDays[p]}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    turnaroundDays: { ...f.turnaroundDays, [p]: Number(e.target.value) },
                  }))
                }
              />
            </Field>
          ))}
          <Field label="Amber when due within (h)" htmlFor="sla-soon">
            <Input
              id="sla-soon"
              type="number"
              min={1}
              max={168}
              value={form.dueSoonHours}
              onChange={(e) => setForm((f) => ({ ...f, dueSoonHours: Number(e.target.value) }))}
            />
          </Field>
        </div>
        <ErrorText error={save.error} />
        <Saved show={save.isSuccess} />
        <Button type="submit" disabled={save.isPending}>
          Save SLA defaults
        </Button>
      </form>
    </Section>
  );
}

function NotificationsCard({
  value,
  events,
}: {
  value: Record<string, { email: boolean; inApp: boolean }>;
  events: string[];
}) {
  const [rules, setRules] = useState(value);
  const save = useSave<{ rules: typeof rules }>('/admin/settings/notifications');
  const flip = (event: string, channel: 'email' | 'inApp', on: boolean) =>
    setRules((r) => ({ ...r, [event]: { ...r[event]!, [channel]: on } }));
  return (
    <Section title="Notification rules">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ rules });
        }}
      >
        <p className="text-sm text-muted">
          Which events send email and in-app notifications. Security emails (sign-in, password,
          two-factor) always go out.
        </p>
        <table className="text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th scope="col" className="py-1 pr-6 font-medium">
                Event
              </th>
              <th scope="col" className="px-3 py-1 font-medium">
                Email
              </th>
              <th scope="col" className="px-3 py-1 font-medium">
                In-app
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <tr key={ev}>
                <th scope="row" className="py-1 pr-6 text-left font-normal text-ink">
                  {EVENT_LABEL[ev] ?? ev}
                </th>
                {(['email', 'inApp'] as const).map((ch) => (
                  <td key={ch} className="px-3 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={`${EVENT_LABEL[ev] ?? ev} ${ch === 'email' ? 'email' : 'in-app'}`}
                      checked={rules[ev]?.[ch] ?? true}
                      onChange={(e) => flip(ev, ch, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorText error={save.error} />
        <Saved show={save.isSuccess} />
        <Button type="submit" disabled={save.isPending}>
          Save notification rules
        </Button>
      </form>
    </Section>
  );
}

const TEMPLATE_GROUPS = [
  ['account', 'Account emails'],
  ['notification', 'Notification emails'],
] as const;

function TemplatesCard() {
  const templates = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => api<{ items: EmailTemplate[] }>('/admin/email-templates'),
  });
  const [key, setKey] = useState('');
  const current = templates.data?.items.find((t) => t.key === key) ?? templates.data?.items[0];
  return (
    <Section title="Email templates">
      <ErrorText error={templates.error} />
      {current && (
        <div className="space-y-4">
          <Field label="Template" htmlFor="tpl-key">
            <Select id="tpl-key" value={current.key} onChange={(e) => setKey(e.target.value)}>
              {TEMPLATE_GROUPS.map(([group, label]) => (
                <optgroup key={group} label={label}>
                  {templates
                    .data!.items.filter((t) => t.group === group)
                    .map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                        {t.customized ? ' (edited)' : ''}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <TemplateEditor key={`${current.key}:${current.updatedAt}`} template={current} />
        </div>
      )}
    </Section>
  );
}

function TemplateEditor({ template }: { template: EmailTemplate }) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const refresh = () => qc.invalidateQueries({ queryKey: ['email-templates'] });
  const save = useMutation({
    mutationFn: () =>
      api<EmailTemplate>(`/admin/email-templates/${template.key}`, {
        method: 'PUT',
        body: { subject, body },
      }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: () =>
      api<EmailTemplate>(`/admin/email-templates/${template.key}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const preview = useMutation({
    mutationFn: () =>
      api<{ subject: string; text: string }>(`/admin/email-templates/${template.key}/preview`, {
        method: 'POST',
        body: { subject, body },
      }),
  });
  const problems = (save.error ?? preview.error) as {
    body?: { error?: { details?: { message: string }[] } };
  } | null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {template.description} Variables:{' '}
        {template.variables.map((v) => (
          <code key={v} className="mr-2 rounded bg-surface px-1">{`{{${v}}}`}</code>
        ))}
        {template.required.length > 0 && (
          <>(required: {template.required.map((v) => `{{${v}}}`).join(', ')})</>
        )}
      </p>
      <Field label="Subject" htmlFor="tpl-subject">
        <Input id="tpl-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Body (plain text)" htmlFor="tpl-body">
        <Textarea id="tpl-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <ErrorText error={save.error ?? preview.error ?? reset.error} />
      {problems?.body?.error?.details && (
        <ul className="list-disc pl-5 text-sm text-red-800">
          {problems.body.error.details.map((d) => (
            <li key={d.message}>{d.message}</li>
          ))}
        </ul>
      )}
      {preview.data && (
        <div className="rounded-md border border-line bg-surface p-3 text-sm">
          <p className="font-medium text-ink">{preview.data.subject}</p>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-body">{preview.data.text}</pre>
        </div>
      )}
      <Saved show={save.isSuccess} />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save template
        </Button>
        <Button variant="secondary" onClick={() => preview.mutate()} disabled={preview.isPending}>
          Preview
        </Button>
        {template.customized && (
          <Button variant="ghost" onClick={() => reset.mutate()} disabled={reset.isPending}>
            Restore default
          </Button>
        )}
        {template.updatedAt && (
          <span className="text-xs text-muted">Edited {dateTime(template.updatedAt)}</span>
        )}
      </div>
    </div>
  );
}

const UPSTREAM_LABEL: Record<string, string> = {
  'nlm-ctss': 'NLM Clinical Tables (ICD-10-CM, HCPCS)',
  'nlm-rxnav': 'NLM RxNav (RxNorm)',
  openfda: 'openFDA drug labels',
  medlineplus: 'MedlinePlus Connect',
};

function MedicalCard({ value }: { value: MedicalStatus }) {
  const [enabled, setEnabled] = useState(value.enabled);
  useEffect(() => setEnabled(value.enabled), [value.enabled]);
  const save = useSave<{ enabled: Record<string, boolean> }>('/admin/settings/medical');
  const usage = new Map(value.usage24h.map((u) => [u.provider, u]));
  return (
    <Section title="Medical data providers">
      <p className="mb-3 text-sm text-muted">
        Provider mode: <Badge tone="brand">{value.provider}</Badge> (set by MEDICAL_DATA_PROVIDER).
        openFDA API key:{' '}
        {value.openFdaApiKeyConfigured ? 'configured' : 'not set (1,000 calls/day)'}. Switching a
        source off makes lookups return &quot;uncoded&quot; instead of calling it.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ enabled });
        }}
      >
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              {[
                'Source',
                'On',
                'Calls (24 h)',
                'Errors',
                'Error rate',
                'Cache hits',
                'Skipped',
              ].map((h) => (
                <th key={h} scope="col" className="py-1 pr-4 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.keys(enabled).map((u) => {
              const s = usage.get(u);
              return (
                <tr key={u}>
                  <th scope="row" className="py-1 pr-4 text-left font-normal text-ink">
                    {UPSTREAM_LABEL[u] ?? u}
                  </th>
                  <td className="py-1 pr-4">
                    <input
                      type="checkbox"
                      aria-label={`${UPSTREAM_LABEL[u] ?? u} enabled`}
                      checked={enabled[u]}
                      onChange={(e) => setEnabled((x) => ({ ...x, [u]: e.target.checked }))}
                    />
                  </td>
                  <td className="py-1 pr-4 tabular-nums">{s?.calls ?? 0}</td>
                  <td className="py-1 pr-4 tabular-nums">{s?.errors ?? 0}</td>
                  <td className="py-1 pr-4 tabular-nums">
                    {s ? `${(s.errorRate * 100).toFixed(1)}%` : '—'}
                  </td>
                  <td className="py-1 pr-4 tabular-nums">{s?.cacheHits ?? 0}</td>
                  <td className="py-1 pr-4 tabular-nums">{s?.skipped ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ErrorText error={save.error} />
        <Saved show={save.isSuccess} />
        <Button type="submit" disabled={save.isPending}>
          Save providers
        </Button>
      </form>
    </Section>
  );
}
