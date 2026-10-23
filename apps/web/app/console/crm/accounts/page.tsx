'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Empty, ErrorText, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { Account, Paged } from '@/lib/types';

export default function AccountsPage() {
  const [q, setQ] = useState('');
  const accounts = useQuery({
    queryKey: ['accounts', q],
    queryFn: () =>
      api<Paged<Account>>(`/accounts?limit=500${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold text-ink">Accounts</h1>
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
          aria-label="Search accounts"
          placeholder="Search by name"
          className="w-64"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <ErrorText error={accounts.error} />
      {accounts.data?.items.length === 0 && <Empty>No client accounts found.</Empty>}
      {!!accounts.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Account', 'Status', 'Plan', 'Contacts', 'Users', 'Client since'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {accounts.data.items.map((a) => (
                <tr key={a.id} className="hover:bg-surface">
                  <td className="px-3 py-2">
                    <Link
                      href={`/console/crm/accounts/${a.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {a.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={a.status === 'active' ? 'green' : 'red'}>{a.status}</Badge>
                  </td>
                  <td className="px-3 py-2">{a.plan?.name ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">{a.contactCount}</td>
                  <td className="px-3 py-2 tabular-nums">{a.userCount}</td>
                  <td className="px-3 py-2">{date(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
