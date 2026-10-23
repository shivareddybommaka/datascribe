'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useCan, useMe } from '@/components/auth';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { Firm, FirmUser, Paged, PendingInvite } from '@/lib/types';

/**
 * §5.3 client_admin: firm profile, MFA policy, firm users and invites. Uses the firm-scoped
 * /admin/users and /invites APIs; the full staff admin console is M2.
 */
export default function FirmPage() {
  const me = useMe();
  const canEdit = useCan('users:edit');
  const canInvite = useCan('users:create');
  const qc = useQueryClient();
  const firm = useQuery({ queryKey: ['firm'], queryFn: () => api<Firm>('/firm') });
  const users = useQuery({
    queryKey: ['firm', 'users'],
    queryFn: () => api<Paged<FirmUser>>('/admin/users?limit=500'),
  });
  const invites = useQuery({
    queryKey: ['firm', 'invites'],
    queryFn: () => api<{ items: PendingInvite[] }>('/firm/invites'),
  });
  const [name, setName] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (body: { name?: string; enforceMfa?: boolean }) =>
      api<Firm>('/firm', { method: 'PATCH', body }),
    onSuccess: (f) => {
      qc.setQueryData(['firm'], f);
      setName(null);
    },
  });
  const userAction = useMutation({
    mutationFn: ({ user, action }: { user: FirmUser; action: 'suspend' | 'reactivate' }) =>
      api(`/admin/users/${user.id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['firm', 'users'] }),
  });

  if (firm.error) return <ErrorText error={firm.error} />;
  if (!firm.data) return <p className="text-sm text-muted">Loading…</p>;
  const f = firm.data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-ink">Firm</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="text-base font-semibold text-ink">Firm profile</h2>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name?.trim()) update.mutate({ name: name.trim() });
            }}
          >
            <Field label="Firm name" htmlFor="firm-name">
              <Input
                id="firm-name"
                value={name ?? f.name}
                disabled={!canEdit}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <p className="text-sm text-muted">
              Plan: {f.plan?.name ?? 'none'} · {f.currency} · {f.userCount} users
            </p>
            {canEdit && (
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={update.isPending || name === null || name.trim() === f.name}
                >
                  Save
                </Button>
              </div>
            )}
          </form>
        </Card>

        <Card>
          <h2 className="text-base font-semibold text-ink">Security</h2>
          <label className="mt-3 flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={f.enforceMfa}
              disabled={!canEdit || update.isPending}
              onChange={(e) => update.mutate({ enforceMfa: e.target.checked })}
            />
            <span>
              <span className="font-medium text-ink">Require two-factor authentication</span>
              <span className="block text-muted">
                Everyone at the firm sets up an authenticator app at their next sign-in.
              </span>
            </span>
          </label>
          <ErrorText error={update.error} />
        </Card>
      </div>

      <Card className="p-0">
        <h2 className="px-5 pt-5 text-base font-semibold text-ink">Users</h2>
        <ErrorText error={users.error ?? userAction.error} />
        {users.data?.items.length === 0 && <Empty>No users.</Empty>}
        {!!users.data?.items.length && (
          <table className="mt-3 w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Name', 'Email', 'Role', 'Status', '2FA', 'Last sign-in', ''].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-2 text-ink">{u.name}</td>
                  <td className="px-4 py-2">{u.email}</td>
                  <td className="px-4 py-2">{u.roles.map((r) => r.name).join(', ')}</td>
                  <td className="px-4 py-2">
                    <Badge tone={u.status === 'active' ? 'green' : 'amber'}>{u.status}</Badge>
                  </td>
                  <td className="px-4 py-2">{u.mfaEnabled ? 'On' : 'Off'}</td>
                  <td className="px-4 py-2">{date(u.lastLoginAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {canEdit && u.id !== me.user.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={userAction.isPending}
                        onClick={() =>
                          userAction.mutate({
                            user: u,
                            action: u.status === 'suspended' ? 'reactivate' : 'suspend',
                          })
                        }
                      >
                        {u.status === 'suspended' ? 'Reactivate' : 'Suspend'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {canInvite && <InviteCard organizationId={f.id} invites={invites.data?.items ?? []} />}
    </div>
  );
}

function InviteCard({
  organizationId,
  invites,
}: {
  organizationId: string;
  invites: PendingInvite[];
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('client_user');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () =>
      api('/invites', { method: 'POST', body: { organizationId, email: email.trim(), roleKey } }),
    onSuccess: async () => {
      setSentTo(email.trim());
      setEmail('');
      await qc.invalidateQueries({ queryKey: ['firm', 'invites'] });
    },
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Invite a colleague</h2>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSentTo(null);
          invite.mutate();
        }}
      >
        <Field label="Email" htmlFor="invite-email" className="w-72">
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Role" htmlFor="invite-role" className="w-48">
          <Select id="invite-role" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>
            <option value="client_user">Client user</option>
            <option value="client_admin">Client admin</option>
          </Select>
        </Field>
        <Button type="submit" disabled={invite.isPending || !email.trim()}>
          Send invite
        </Button>
      </form>
      {sentTo && (
        <p role="status" className="mt-2 text-sm text-green-800">
          Invite sent to {sentTo}. The link is valid for 72 hours.
        </p>
      )}
      <ErrorText error={invite.error} />
      {invites.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold text-ink">Pending invites</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {invites.map((i) => (
              <li key={i.id} className="flex gap-3 py-2">
                <span className="text-ink">{i.email}</span>
                <span className="text-muted">{i.role.name}</span>
                <span className="ml-auto text-muted">expires {date(i.expiresAt)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
