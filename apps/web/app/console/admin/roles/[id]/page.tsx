'use client';

import {
  ACTIONS,
  CLIENT_MODULES,
  MODULES,
  RESERVED_MODULES,
  SCOPES,
  type Module,
} from '@datascribe/shared/permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useMe } from '@/components/auth';
import { Badge, Button, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import type { RoleRow } from '@/lib/types';

const MODULE_LABEL: Record<Module, string> = {
  cms: 'Website CMS',
  crm: 'CRM',
  cases: 'Cases',
  documents: 'Documents (medical records)',
  deliverables: 'Deliverables',
  qa_reviews: 'QA reviews',
  invoices: 'Invoices',
  payments: 'Payments',
  subscriptions: 'Subscriptions',
  users: 'Users and roles',
  dashboard_ops: 'Ops dashboard',
  dashboard_sales: 'Sales dashboard',
  dashboard_finance: 'Finance dashboard',
  dashboard_client: 'Client dashboard',
  audit_log: 'Audit log',
  system_settings: 'System settings',
};

const SCOPE_HINT: Record<string, string> = {
  all: 'every organization',
  firm: "the user's own organization",
  assigned: 'records assigned to the user',
  own: 'records the user created or that were shared with them',
};

export default function RoleEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'new';
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const role = useQuery({
    queryKey: ['role', id],
    queryFn: () => api<RoleRow & { invitesPending: number }>(`/roles/${id}`),
    enabled: !isNew,
  });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [group, setGroup] = useState<'internal' | 'client'>('internal');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (role.data) {
      setName(role.data.name);
      setDescription(role.data.description ?? '');
      setGroup(role.data.group);
      setPerms(new Set(role.data.permissions));
    }
  }, [role.data]);

  const isSuper = me.roles.includes('super_admin');
  const staffAdmin = me.user.orgType === 'internal';
  const editable = isNew
    ? staffAdmin && me.permissions.includes('users:create:all')
    : !!role.data &&
      !role.data.locked &&
      staffAdmin &&
      me.permissions.includes('users:edit:all') &&
      (!role.data.isSystem || isSuper);
  const canDelete =
    !isNew && !!role.data && !role.data.isSystem && me.permissions.includes('users:delete:all');

  const modules = MODULES.filter(
    (m) =>
      (group === 'internal' || CLIENT_MODULES.includes(m)) &&
      // reserved modules only show on the built-in super_admin role (read-only)
      (!RESERVED_MODULES.includes(m) || role.data?.locked),
  );
  const scopes = SCOPES.filter((s) => group === 'internal' || s !== 'all');

  const toggle = (key: string, on: boolean) =>
    setPerms((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const save = useMutation({
    mutationFn: () => {
      // drop anything the group no longer allows (e.g. switched to client while drafting)
      const permissions = [...perms].filter((k) => {
        const [m, , s] = k.split(':');
        return modules.includes(m as Module) && scopes.includes(s as (typeof SCOPES)[number]);
      });
      const body = { name: name.trim(), description: description.trim() || null, permissions };
      return isNew
        ? api<RoleRow>('/roles', { method: 'POST', body: { ...body, group } })
        : api<RoleRow>(`/roles/${id}`, { method: 'PATCH', body });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      qc.setQueryData(['role', r.id], r);
      setSaved(
        `Saved. ${r.permissions.length} permission(s); holders get them on their next request.`,
      );
      if (isNew) router.replace(`/console/admin/roles/${r.id}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/roles/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      router.push('/console/admin/roles');
    },
  });

  if (!isNew && role.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (!isNew && role.error) return <ErrorText error={role.error} />;

  return (
    <div className="space-y-5">
      <Link href="/console/admin/roles" className="text-sm text-brand-700 hover:underline">
        ← Roles
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-ink">{isNew ? 'New role' : role.data!.name}</h1>
        {role.data && (
          <>
            <Badge tone={role.data.isSystem ? 'neutral' : 'brand'}>
              {role.data.isSystem ? 'built-in' : 'custom'}
            </Badge>
            <span className="text-sm text-muted">
              {role.data.userCount} user(s) · key <code>{role.data.key}</code>
            </span>
          </>
        )}
      </div>
      {role.data?.locked && (
        <p className="text-sm text-muted">Super Admin always holds every permission.</p>
      )}

      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(null);
          save.mutate();
        }}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Role name" htmlFor="role-name">
            <Input
              id="role-name"
              required
              minLength={2}
              maxLength={80}
              disabled={!editable}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="For" htmlFor="role-group">
            <Select
              id="role-group"
              disabled={!isNew}
              value={group}
              onChange={(e) => setGroup(e.target.value as 'internal' | 'client')}
            >
              <option value="internal">Datascribe staff</option>
              <option value="client">Client firm users</option>
            </Select>
          </Field>
          <Field label="Description" htmlFor="role-description">
            <Textarea
              id="role-description"
              rows={1}
              maxLength={300}
              disabled={!editable}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        {group === 'client' && (
          <p className="text-sm text-muted">
            Client roles only cover client modules and never reach other firms (no &quot;all&quot;
            scope).
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm" aria-label="Permission matrix">
            <thead className="bg-surface text-left text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Module
                </th>
                {ACTIONS.map((a) => (
                  <th key={a} scope="col" className="px-2 py-2 text-center font-medium">
                    {a}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {modules.map((m) => (
                <tr key={m} className="align-top hover:bg-surface">
                  <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                    {MODULE_LABEL[m]}
                  </th>
                  {ACTIONS.map((a) => (
                    <td key={a} className="px-2 py-1.5">
                      <div className="flex flex-col items-start gap-0.5">
                        {scopes.map((s) => {
                          const key = `${m}:${a}:${s}`;
                          return (
                            <label
                              key={s}
                              className="flex items-center gap-1 text-xs text-body"
                              title={`${MODULE_LABEL[m]}: ${a}, ${SCOPE_HINT[s]}`}
                            >
                              <input
                                type="checkbox"
                                aria-label={`${m} ${a} ${s}`}
                                disabled={!editable}
                                checked={perms.has(key)}
                                onChange={(e) => toggle(key, e.target.checked)}
                              />
                              {s}
                            </label>
                          );
                        })}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          Scopes: all = {SCOPE_HINT.all}; firm = {SCOPE_HINT.firm}; assigned = {SCOPE_HINT.assigned}
          ; own = {SCOPE_HINT.own}. You can only grant permissions you hold yourself.
        </p>

        {saved && (
          <p role="status" className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-900">
            {saved}
          </p>
        )}
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex gap-2">
          {editable && (
            <Button type="submit" disabled={save.isPending}>
              {isNew ? 'Create role' : 'Save permissions'}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="danger"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Delete the role "${role.data!.name}"?`)) remove.mutate();
              }}
            >
              Delete role
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
