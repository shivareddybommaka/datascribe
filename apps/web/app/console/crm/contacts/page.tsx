'use client';

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { CsvImport } from '@/components/crm/csv-import';
import { Button, Empty, ErrorText, Input } from '@/components/ui';
import { api, downloadCsv } from '@/lib/api';
import type { Contact, Paged } from '@/lib/types';

export default function ContactsPage() {
  const qc = useQueryClient();
  const canCreate = useCan('crm:create');
  const canExport = useCan('crm:export');
  const [q, setQ] = useState('');
  const qs = q ? `q=${encodeURIComponent(q)}` : '';
  const contacts = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api<Paged<Contact>>(`/contacts?limit=500${qs ? `&${qs}` : ''}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold text-ink">Contacts</h1>
        {canExport && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadCsv(`/contacts/export?${qs}`, 'contacts.csv')}
          >
            Export CSV
          </Button>
        )}
        {canCreate && (
          <CsvImport
            path="/contacts/import"
            columnsHint="name, title, email, phone, accountId, leadId"
            onImported={() => void qc.invalidateQueries({ queryKey: ['contacts'] })}
          />
        )}
      </div>
      <form
        role="search"
        className="flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setQ(String(new FormData(e.currentTarget).get('q') ?? '').trim());
        }}
      >
        <Input
          name="q"
          aria-label="Search contacts"
          placeholder="Search name or email"
          className="w-64"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <ErrorText error={contacts.error} />
      {contacts.data?.items.length === 0 && <Empty>No contacts found.</Empty>}
      {!!contacts.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Name', 'Title', 'Email', 'Phone', 'Account / lead'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {contacts.data.items.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2 font-medium text-ink">{c.name}</td>
                  <td className="px-3 py-2">{c.title ?? '—'}</td>
                  <td className="px-3 py-2">{c.email ?? '—'}</td>
                  <td className="px-3 py-2">{c.phone ?? '—'}</td>
                  <td className="px-3 py-2">
                    {c.organization ? (
                      <Link
                        href={`/console/crm/accounts/${c.organization.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {c.organization.name}
                      </Link>
                    ) : c.lead ? (
                      <Link
                        href={`/console/crm/leads/${c.lead.id}`}
                        className="text-brand-700 hover:underline"
                      >
                        {c.lead.companyName} (lead)
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
