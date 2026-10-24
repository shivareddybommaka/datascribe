'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from './auth';
import { Badge, Button, Card, Empty, ErrorText, cn } from './ui';

/** M9 in-app notifications (§5.8, D-091). The API scopes everything to the signed-in user. */
export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

interface Page {
  items: AppNotification[];
  nextCursor: string | null;
}

interface Preference {
  type: string;
  label: string;
  description: string;
  category: string;
  critical: boolean;
  email: boolean;
  inApp: boolean;
  emailDisabledByAdmin: boolean;
  inAppDisabledByAdmin: boolean;
}

type Area = 'portal' | 'console';

const KEY = ['notifications'] as const;
const POLL_MS = 30_000;

function useMarkRead() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const one = useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const all = useMutation({
    mutationFn: () => api('/notifications/read-all', { method: 'POST' }),
    onSuccess: refresh,
  });
  return { one, all };
}

function BellIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
    >
      <path
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0a3 3 0 1 1-6 0m6 0H9"
      />
    </svg>
  );
}

function Item({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  const content = (
    <>
      <p className={cn('text-sm text-ink', !n.readAt && 'font-semibold')}>{n.title}</p>
      <p className="mt-0.5 text-xs text-body">{n.body}</p>
      <p className="mt-1 text-xs text-muted">{dateTime(n.createdAt)}</p>
    </>
  );
  const cls = cn('block w-full px-4 py-3 text-left hover:bg-surface', !n.readAt && 'bg-brand-50');
  return n.link ? (
    <Link href={n.link} className={cls} onClick={() => onOpen(n)}>
      {content}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={() => onOpen(n)}>
      {content}
    </button>
  );
}

/** Header bell: unread count (polled), the latest notifications and "mark all read". */
export function NotificationBell({ area }: { area: Area }) {
  const me = useMe();
  const readOnly = !!me.impersonation;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const count = useQuery({
    queryKey: [...KEY, 'count'],
    queryFn: () => api<{ count: number }>('/notifications/unread-count'),
    refetchInterval: POLL_MS,
  });
  const latest = useQuery({
    queryKey: [...KEY, 'latest'],
    queryFn: () => api<Page>('/notifications?limit=8'),
    enabled: open,
  });
  const mark = useMarkRead();
  const unread = count.data?.count ?? 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const openItem = (n: AppNotification) => {
    if (!n.readAt && !readOnly) mark.one.mutate(n.id);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="relative rounded-md p-1.5 text-body hover:bg-surface"
      >
        <BellIcon />
        {unread > 0 && (
          <span
            data-testid="notification-count"
            className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-700 px-1 text-center text-[11px] font-semibold leading-5 text-white"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 z-20 mt-2 w-96 overflow-hidden rounded-lg border border-line bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <h2 className="text-sm font-semibold text-ink">Notifications</h2>
            {unread > 0 && !readOnly && (
              <button
                type="button"
                className="text-xs text-brand-700 hover:underline"
                onClick={() => mark.all.mutate()}
              >
                Mark all read
              </button>
            )}
          </div>
          <ErrorText error={latest.error} />
          {latest.data?.items.length === 0 && <Empty>No notifications yet.</Empty>}
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {latest.data?.items.map((n) => (
              <li key={n.id}>
                <Item n={n} onOpen={openItem} />
              </li>
            ))}
          </ul>
          <Link
            href={`/${area}/notifications`}
            onClick={() => setOpen(false)}
            className="block border-t border-line px-4 py-2 text-center text-sm text-brand-700 hover:bg-surface"
          >
            All notifications and settings
          </Link>
        </div>
      )}
    </div>
  );
}

/** Full list (paged) plus the user's email / in-app choices per type. */
export function NotificationCentre() {
  const me = useMe();
  const readOnly = !!me.impersonation;
  const list = useInfiniteQuery({
    queryKey: [...KEY, 'all'],
    queryFn: ({ pageParam }) =>
      api<Page>(`/notifications?limit=20${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const mark = useMarkRead();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Notifications</h1>
        {!readOnly && items.some((n) => !n.readAt) && (
          <Button variant="secondary" size="sm" onClick={() => mark.all.mutate()}>
            Mark all read
          </Button>
        )}
      </div>
      <Card className="p-0">
        <ErrorText error={list.error ?? mark.one.error ?? mark.all.error} />
        {list.data && items.length === 0 && <Empty>No notifications yet.</Empty>}
        <ul className="divide-y divide-line">
          {items.map((n) => (
            <li key={n.id}>
              <Item n={n} onOpen={(x) => !x.readAt && !readOnly && mark.one.mutate(x.id)} />
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more
            </Button>
          </div>
        )}
      </Card>
      <Preferences readOnly={readOnly} />
    </div>
  );
}

function Preferences({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const prefs = useQuery({
    queryKey: [...KEY, 'preferences'],
    queryFn: () => api<{ items: Preference[] }>('/notifications/preferences'),
  });
  const save = useMutation({
    mutationFn: (item: { type: string; email?: boolean; inApp?: boolean }) =>
      api<{ items: Preference[] }>('/notifications/preferences', {
        method: 'PUT',
        body: { items: [item] },
      }),
    onSuccess: (data) => qc.setQueryData([...KEY, 'preferences'], data),
  });

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">What you are told about</h2>
      <p className="mt-1 text-sm text-muted">
        Security and payment-failure notices are always sent and can&apos;t be muted.
      </p>
      <ErrorText error={prefs.error ?? save.error} />
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-muted">
            <th className="py-2 font-medium">Notification</th>
            <th className="w-20 py-2 text-center font-medium">In app</th>
            <th className="w-20 py-2 text-center font-medium">Email</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {prefs.data?.items.map((p) => (
            <tr key={p.type}>
              <td className="py-2 pr-4">
                <span className="font-medium text-ink">{p.label}</span>{' '}
                {p.critical && <Badge tone="amber">Always on</Badge>}
                <p className="text-xs text-muted">{p.description}</p>
              </td>
              {(['inApp', 'email'] as const).map((channel) => {
                const offByAdmin =
                  channel === 'email' ? p.emailDisabledByAdmin : p.inAppDisabledByAdmin;
                return (
                  <td key={channel} className="py-2 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-brand-600"
                      aria-label={`${p.label}: ${channel === 'email' ? 'email' : 'in app'}`}
                      title={offByAdmin ? 'Turned off for everyone by an administrator' : undefined}
                      checked={p[channel] && !offByAdmin}
                      disabled={p.critical || offByAdmin || readOnly || save.isPending}
                      onChange={(e) => save.mutate({ type: p.type, [channel]: e.target.checked })}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
