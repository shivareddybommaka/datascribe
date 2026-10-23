'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useCan } from '@/components/auth';
import { ActivityPanel } from '@/components/crm/activity-panel';
import { ContactsPanel } from '@/components/crm/contacts-panel';
import { LeadForm } from '@/components/crm/lead-form';
import { Badge, Button, Card, Dialog, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { SOURCE_LABEL, STAGE_LABEL, date, dateTime, money } from '@/lib/format';
import type { LeadDetail } from '@/lib/types';
import { stageTone } from '../leads-view';

interface ConvertResult {
  organization: { id: string; name: string };
  invite: { email: string; expiresAt: string } | null;
  inviteError?: string;
}

export default function LeadPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const canEdit = useCan('crm:edit');
  const canDelete = useCan('crm:delete');
  const key = ['lead', id];

  const lead = useQuery({ queryKey: key, queryFn: () => api<LeadDetail>(`/leads/${id}`) });
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(params.get('convert') === '1');
  const [converted, setConverted] = useState<ConvertResult | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['pipeline-summary'] });
  };

  const convert = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ConvertResult>(`/leads/${id}/convert`, { method: 'POST', body }),
    onSuccess: (res) => {
      setConverted(res);
      refresh();
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/leads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      router.replace('/console/crm/leads');
    },
  });

  if (lead.error) return <ErrorText error={lead.error} />;
  if (!lead.data) return <p className="text-sm text-muted">Loading…</p>;
  const l = lead.data;
  const isConverted = !!l.convertedOrgId;

  function onConvert(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? '').trim() || undefined;
    convert.mutate({ organizationName: val('organizationName'), adminEmail: val('adminEmail') });
  }

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/console/crm/leads" className="text-brand-700 hover:underline">
          ← Leads
        </Link>
      </nav>
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-semibold text-ink">{l.companyName}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={stageTone(l.stage)}>{STAGE_LABEL[l.stage]}</Badge>
            {SOURCE_LABEL[l.source] ?? l.source} · created {date(l.createdAt)}
          </p>
        </div>
        {canEdit && !isConverted && (
          <>
            <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
              {editing ? 'Close editor' : 'Edit'}
            </Button>
            <Button onClick={() => setConverting(true)}>Convert to client</Button>
          </>
        )}
        {canDelete && !isConverted && (
          <Button
            variant="ghost"
            onClick={() => {
              if (window.confirm(`Delete lead "${l.companyName}" and its activity history?`))
                remove.mutate();
            }}
          >
            Delete
          </Button>
        )}
      </div>
      <ErrorText error={remove.error} />

      {isConverted && l.convertedOrg && (
        <p role="status" className="rounded-md bg-green-50 px-4 py-3 text-sm text-green-900">
          Converted to client{' '}
          <Link
            href={`/console/crm/accounts/${l.convertedOrg.id}`}
            className="font-medium underline"
          >
            {l.convertedOrg.name}
          </Link>{' '}
          on {date(l.convertedAt)}.
        </p>
      )}

      {editing ? (
        <Card>
          <LeadForm
            lead={l}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              refresh();
            }}
          />
        </Card>
      ) : (
        <Card>
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
            {[
              ['Contact', l.contactName],
              ['Email', l.email ?? '—'],
              ['Phone', l.phone ?? '—'],
              ['Owner', l.owner?.name ?? 'Unassigned'],
              ['Estimated value', money(l.value, l.currency)],
              ['Next follow-up', date(l.nextFollowUpAt)],
              ...(l.stage === 'lost' ? [['Lost reason', l.lostReason ?? '—']] : []),
              ['Last updated', dateTime(l.updatedAt)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-muted">{k}</dt>
                <dd className="text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          {l.notes && <p className="mt-4 whitespace-pre-wrap text-sm text-body">{l.notes}</p>}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActivityPanel activities={l.activities} link={{ leadId: l.id }} invalidate={key} />
        </div>
        <ContactsPanel contacts={l.contacts} link={{ leadId: l.id }} invalidate={key} />
      </div>

      <Dialog
        open={converting}
        onClose={() => {
          setConverting(false);
          setConverted(null);
          convert.reset();
        }}
        title="Convert to client"
      >
        {converted ? (
          <div role="status" className="space-y-3 text-sm">
            <p className="text-ink">
              Created client account <strong>{converted.organization.name}</strong>.
            </p>
            {converted.invite ? (
              <p>
                Invite sent to <strong>{converted.invite.email}</strong> as client admin (expires{' '}
                {dateTime(converted.invite.expiresAt)}).
              </p>
            ) : (
              <p className="text-amber-900">
                The account was created but the invite could not be sent ({converted.inviteError}).
              </p>
            )}
            <Link
              href={`/console/crm/accounts/${converted.organization.id}`}
              className="inline-block font-medium text-brand-700 underline"
            >
              Open account
            </Link>
          </div>
        ) : (
          <form onSubmit={onConvert} className="space-y-4">
            <p className="text-sm text-body">
              Creates a client organisation, marks this lead as won and emails a 72-hour invite to
              the firm&apos;s first client admin. Contacts and activity history move to the account.
            </p>
            <Field label="Organisation name" htmlFor="organizationName">
              <Input
                id="organizationName"
                name="organizationName"
                defaultValue={l.companyName}
                required
              />
            </Field>
            <Field label="Client admin email" htmlFor="adminEmail">
              <Input
                id="adminEmail"
                name="adminEmail"
                type="email"
                defaultValue={l.email ?? ''}
                required
              />
            </Field>
            <ErrorText error={convert.error} />
            <Button type="submit" disabled={convert.isPending}>
              {convert.isPending ? 'Converting…' : 'Convert and send invite'}
            </Button>
          </form>
        )}
      </Dialog>
    </div>
  );
}
