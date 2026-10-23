'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { useCan } from '../auth';
import { api } from '@/lib/api';
import type { Contact } from '@/lib/types';
import { Button, Card, Empty, ErrorText, Input } from '../ui';

export function ContactsPanel({
  contacts,
  link,
  invalidate,
}: {
  contacts: Contact[];
  link: { leadId?: string; organizationId?: string };
  invalidate: unknown[];
}) {
  const qc = useQueryClient();
  const canCreate = useCan('crm:create');
  const canDelete = useCan('crm:delete');
  const refresh = () => void qc.invalidateQueries({ queryKey: invalidate });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/contacts', { method: 'POST', body }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const val = (k: string) => String(f.get(k) ?? '').trim() || null;
    create.mutate(
      { name: val('name'), title: val('title'), email: val('email'), phone: val('phone'), ...link },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Contacts</h2>
      {contacts.length === 0 && <Empty>No contacts yet.</Empty>}
      <ul className="mt-3 divide-y divide-line text-sm">
        {contacts.map((c) => (
          <li key={c.id} className="flex items-start justify-between gap-3 py-2">
            <div>
              <p className="font-medium text-ink">
                {c.name}
                {c.title && <span className="font-normal text-muted"> · {c.title}</span>}
              </p>
              <p className="text-muted">{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</p>
            </div>
            {canDelete && (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${c.name}`}
                onClick={() => remove.mutate(c.id)}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canCreate && (
        <form onSubmit={onSubmit} className="mt-3 grid gap-2 sm:grid-cols-2">
          <Input name="name" aria-label="Contact name" placeholder="Name" required />
          <Input name="title" aria-label="Title" placeholder="Title" />
          <Input name="email" aria-label="Contact email" type="email" placeholder="Email" />
          <Input name="phone" aria-label="Contact phone" type="tel" placeholder="Phone" />
          <div className="sm:col-span-2">
            <ErrorText error={create.error ?? remove.error} />
            <Button type="submit" size="sm" variant="secondary" disabled={create.isPending}>
              Add contact
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
