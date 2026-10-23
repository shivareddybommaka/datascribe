'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ActivityPanel } from '@/components/crm/activity-panel';
import { ContactsPanel } from '@/components/crm/contacts-panel';
import { Badge, Card, Empty, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import type { AccountDetail } from '@/lib/types';

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const key = ['account', id];
  const account = useQuery({ queryKey: key, queryFn: () => api<AccountDetail>(`/accounts/${id}`) });

  if (account.error) return <ErrorText error={account.error} />;
  if (!account.data) return <p className="text-sm text-muted">Loading…</p>;
  const a = account.data;

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/console/crm/accounts" className="text-brand-700 hover:underline">
          ← Accounts
        </Link>
      </nav>
      <div>
        <h1 className="text-2xl font-semibold text-ink">{a.name}</h1>
        <p className="mt-1 flex items-center gap-2 text-sm text-muted">
          <Badge tone={a.status === 'active' ? 'green' : 'red'}>{a.status}</Badge>
          Client since {date(a.createdAt)} ·{' '}
          {a.plan
            ? `${a.plan.name} (${money(a.plan.priceMonthly, a.plan.currency)}/mo)`
            : 'No plan'}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <h2 className="text-base font-semibold text-ink">Portal users</h2>
          {a.users.length === 0 && <Empty>No users yet (invite pending).</Empty>}
          <ul className="mt-3 divide-y divide-line text-sm">
            {a.users.map((u) => (
              <li key={u.id} className="py-2">
                <p className="font-medium text-ink">{u.name}</p>
                <p className="text-muted">
                  {u.email} · {u.roles.join(', ')} · {u.status}
                </p>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <h2 className="text-base font-semibold text-ink">Originating lead</h2>
          {a.leads.length === 0 && <Empty>Self-registered or created by admin.</Empty>}
          <ul className="mt-3 text-sm">
            {a.leads.map((l) => (
              <li key={l.id}>
                <Link
                  href={`/console/crm/leads/${l.id}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {l.companyName}
                </Link>
                <p className="text-muted">
                  Won {date(l.convertedAt)} · {l.owner?.name ?? 'no owner'} ·{' '}
                  {money(l.value, l.currency)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
        <ContactsPanel contacts={a.contacts} link={{ organizationId: a.id }} invalidate={key} />
      </div>
      <ActivityPanel activities={a.activities} link={{ organizationId: a.id }} invalidate={key} />
    </div>
  );
}
