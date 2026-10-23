'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { dateTime, endOfLocalDay } from '@/lib/format';
import type { Activity } from '@/lib/types';
import { Badge, Card, Empty, ErrorText } from './ui';

/** §5.5 "My tasks today": open tasks assigned to me due by the end of my local day, overdue first. */
export function MyTasks() {
  const qc = useQueryClient();
  const tasks = useQuery({
    queryKey: ['my-tasks'],
    queryFn: () =>
      api<{ items: Activity[] }>(
        `/activities/my-tasks?dueBefore=${encodeURIComponent(endOfLocalDay())}`,
      ),
  });
  const done = useMutation({
    mutationFn: (id: string) => api(`/activities/${id}`, { method: 'PATCH', body: { done: true } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-tasks'] });
      void qc.invalidateQueries({ queryKey: ['activities'] });
    },
  });

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">My tasks today</h2>
      <ErrorText error={tasks.error ?? done.error} />
      {tasks.data?.items.length === 0 && <Empty>Nothing due today.</Empty>}
      <ul className="mt-3 divide-y divide-line">
        {tasks.data?.items.map((t) => (
          <li key={t.id} className="flex items-start gap-3 py-3">
            <input
              type="checkbox"
              aria-label={`Mark "${t.subject}" done`}
              className="mt-1 h-4 w-4 accent-brand-600"
              disabled={done.isPending}
              onChange={() => done.mutate(t.id)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{t.subject}</p>
              <p className="text-xs text-muted">
                {t.lead ? (
                  <Link
                    className="text-brand-700 hover:underline"
                    href={`/console/crm/leads/${t.lead.id}`}
                  >
                    {t.lead.companyName}
                  </Link>
                ) : t.organization ? (
                  <Link
                    className="text-brand-700 hover:underline"
                    href={`/console/crm/accounts/${t.organization.id}`}
                  >
                    {t.organization.name}
                  </Link>
                ) : null}
                {(t.lead || t.organization) && ' · '}
                Due {dateTime(t.dueAt)}
              </p>
            </div>
            {t.overdue && <Badge tone="red">Overdue</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
