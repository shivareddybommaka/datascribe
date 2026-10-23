'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useImpersonation } from '@/components/admin/impersonation';
import { useCan, useMe } from '@/components/auth';
import { Badge, Button, Dialog, Empty, ErrorText, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { AdminUser, OrgRow, Paged, RoleRow } from '@/lib/types';

const PAGE = 50;

export default function UsersPage() {
  const canCreate = useCan('users:create');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<AdminUser | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  if (role) params.set('role', role);
  const users = useQuery({
    queryKey: ['admin-users', { q, status, role, offset }],
    queryFn: () => api<Paged<AdminUser>>(`/admin/users?${params}`),
    placeholderData: keepPreviousData,
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<{ items: RoleRow[] }>('/roles'),
  });
  const data = users.data;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Users</h1>
        {canCreate && <Button onClick={() => setInviting(true)}>Invite user</Button>}
      </div>

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
          <Input name="q" aria-label="Search users" placeholder="Name or email" className="w-64" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
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
        </Select>
        <Select
          aria-label="Role"
          className="w-56"
          value={role}
          onChange={(e) => {
            setOffset(0);
            setRole(e.target.value);
          }}
        >
          <option value="">Any role</option>
          {roles.data?.items.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name}
            </option>
          ))}
        </Select>
      </div>

      <ErrorText error={users.error} />
      {data?.items.length === 0 && <Empty>No users match.</Empty>}
      {!!data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['User', 'Organization', 'Roles', 'Status', 'Last sign-in', ''].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((u) => (
                <tr key={u.id} className="hover:bg-surface">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{u.name}</div>
                    <div className="text-muted">{u.email}</div>
                  </td>
                  <td className="px-3 py-2">{u.organization.name}</td>
                  <td className="px-3 py-2">{u.roles.map((r) => r.name).join(', ') || '—'}</td>
                  <td className="space-x-1 px-3 py-2">
                    <UserBadges user={u} />
                  </td>
                  <td className="px-3 py-2 text-muted">{dateTime(u.lastLoginAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      variant="secondary"
                      size="sm"
                      aria-label={`Manage ${u.email}`}
                      onClick={() => setSelected(u)}
                    >
                      Manage
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted">
          {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={offset + PAGE >= data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
      {inviting && (
        <InviteDialog roles={roles.data?.items ?? []} onClose={() => setInviting(false)} />
      )}
      {selected && (
        <UserDialog
          user={selected}
          roles={roles.data?.items ?? []}
          onClose={() => setSelected(null)}
          onChange={setSelected}
        />
      )}
    </div>
  );
}

function UserBadges({ user }: { user: AdminUser }) {
  return (
    <>
      <Badge
        tone={user.status === 'active' ? 'green' : user.status === 'suspended' ? 'red' : 'neutral'}
      >
        {user.status}
      </Badge>
      {user.locked && <Badge tone="amber">locked</Badge>}
      {user.mustResetPassword && <Badge tone="amber">password reset pending</Badge>}
      {user.mfaEnabled && <Badge tone="brand">MFA</Badge>}
    </>
  );
}

function InviteDialog({ roles, onClose }: { roles: RoleRow[]; onClose: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const allOrgs = me.permissions.includes('users:create:all') && me.user.orgType === 'internal';
  const orgs = useQuery({
    queryKey: ['admin-orgs', 'all'],
    queryFn: () => api<Paged<OrgRow>>('/admin/organizations?limit=500&status=active'),
    enabled: allOrgs,
  });
  const [organizationId, setOrganizationId] = useState(allOrgs ? '' : me.user.organizationId);
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const org = orgs.data?.items.find((o) => o.id === organizationId);
  const orgType = allOrgs ? org?.type : me.user.orgType;
  const roleOptions = roles.filter((r) => !orgType || r.group === orgType);

  const invite = useMutation({
    mutationFn: () =>
      api<{ email: string }>('/admin/users', {
        method: 'POST',
        body: { organizationId, email: email.trim(), roleKey },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <Dialog open onClose={onClose} title="Invite user">
      {invite.isSuccess ? (
        <div className="space-y-4">
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">
            Invite sent to {invite.data.email}. The link expires in 72 hours.
          </p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <p className="text-sm text-muted">
            Datascribe never sets passwords for people: they get an email link to create their
            account.
          </p>
          {allOrgs && (
            <Field label="Organization" htmlFor="invite-org">
              <Select
                id="invite-org"
                required
                value={organizationId}
                onChange={(e) => {
                  setOrganizationId(e.target.value);
                  setRoleKey('');
                }}
              >
                <option value="">Choose…</option>
                {orgs.data?.items.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Email" htmlFor="invite-email">
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              required
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
            >
              <option value="">Choose…</option>
              {roleOptions.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorText error={invite.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              Send invite
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function UserDialog({
  user,
  roles,
  onClose,
  onChange,
}: {
  user: AdminUser;
  roles: RoleRow[];
  onClose: () => void;
  onChange: (u: AdminUser) => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const canEdit = useCan('users:edit');
  const { start } = useImpersonation();
  const isSelf = user.id === me.user.id;
  const [roleKeys, setRoleKeys] = useState(user.roles.map((r) => r.key));
  const [notice, setNotice] = useState<string | null>(null);
  const options = roles.filter((r) => r.group === user.organization.type);

  const run = useMutation({
    mutationFn: (args: { path: string; notice: string; body?: Record<string, unknown> }) =>
      args.body
        ? api<AdminUser>(`/admin/users/${user.id}/${args.path}`, { method: 'PUT', body: args.body })
        : api<AdminUser>(`/admin/users/${user.id}/${args.path}`, { method: 'POST' }),
    onSuccess: async (fresh, args) => {
      onChange(fresh);
      setNotice(args.notice);
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  const impersonate = useMutation({
    mutationFn: async () => {
      await start(user.id);
      onClose();
    },
  });

  const canImpersonate =
    me.roles.includes('super_admin') &&
    !me.impersonation &&
    user.organization.type === 'client' &&
    user.status === 'active';

  return (
    <Dialog open onClose={onClose} title={user.name}>
      <div className="space-y-5 text-sm">
        <div className="space-y-1">
          <p className="text-muted">{user.email}</p>
          <p>
            {user.organization.name} · <UserBadges user={user} />
          </p>
        </div>

        {notice && (
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-green-900">
            {notice}
          </p>
        )}
        <ErrorText error={run.error ?? impersonate.error} />

        {canEdit && !isSelf && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              run.mutate({ path: 'roles', notice: 'Roles saved.', body: { roleKeys } });
            }}
          >
            <fieldset>
              <legend className="mb-1 font-medium text-ink">Roles</legend>
              <div className="grid grid-cols-2 gap-1">
                {options.map((r) => (
                  <label key={r.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={roleKeys.includes(r.key)}
                      onChange={(e) =>
                        setRoleKeys((ks) =>
                          e.target.checked ? [...ks, r.key] : ks.filter((k) => k !== r.key),
                        )
                      }
                    />
                    {r.name}
                    {!r.isSystem && <Badge tone="brand">custom</Badge>}
                  </label>
                ))}
              </div>
            </fieldset>
            <Button type="submit" size="sm" disabled={run.isPending || roleKeys.length === 0}>
              Save roles
            </Button>
          </form>
        )}

        {canEdit && !isSelf && (
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {user.status === 'suspended' ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={run.isPending}
                onClick={() => run.mutate({ path: 'reactivate', notice: 'User reactivated.' })}
              >
                Reactivate
              </Button>
            ) : (
              <Button
                size="sm"
                variant="danger"
                disabled={run.isPending}
                onClick={() =>
                  run.mutate({ path: 'suspend', notice: 'User suspended and signed out.' })
                }
              >
                Suspend
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={run.isPending}
              onClick={() =>
                run.mutate({ path: 'reset-mfa', notice: 'Two-factor reset; the user was emailed.' })
              }
            >
              Reset MFA
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={run.isPending}
              onClick={() =>
                run.mutate({
                  path: 'force-password-reset',
                  notice: 'Password reset link emailed; sign-in is blocked until it is used.',
                })
              }
            >
              Force password reset
            </Button>
          </div>
        )}

        {canImpersonate && (
          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-muted">
              See the console exactly as this user does. Read-only: every change is blocked, and the
              start and end are recorded in the audit log.
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={impersonate.isPending}
              onClick={() => impersonate.mutate()}
            >
              View as {user.name} (read-only)
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
