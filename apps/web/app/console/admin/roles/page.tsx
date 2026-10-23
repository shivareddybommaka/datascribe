'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMe } from '@/components/auth';
import { Badge, Empty, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';
import type { RoleRow } from '@/lib/types';

export default function RolesPage() {
  const me = useMe();
  const canCreate = me.user.orgType === 'internal' && me.permissions.includes('users:create:all');
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api<{ items: RoleRow[] }>('/roles'),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-ink">Roles</h1>
        {canCreate && (
          <Link
            href="/console/admin/roles/new"
            className="inline-flex h-10 items-center rounded-md bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            New role
          </Link>
        )}
      </div>
      <p className="text-sm text-muted">
        A role is a set of permissions (module × action × scope). Changes apply to everyone holding
        the role on their next request. Built-in roles can&apos;t be deleted.
      </p>
      <ErrorText error={roles.error} />
      {roles.data?.items.length === 0 && <Empty>No roles.</Empty>}
      {!!roles.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Role', 'Group', 'Type', 'Users', 'Permissions'].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {roles.data.items.map((r) => (
                <tr key={r.id} className="hover:bg-surface">
                  <td className="px-3 py-2">
                    <Link
                      href={`/console/admin/roles/${r.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {r.name}
                    </Link>
                    <div className="text-xs text-muted">{r.description ?? r.key}</div>
                  </td>
                  <td className="px-3 py-2">
                    {r.group === 'internal' ? 'Datascribe staff' : 'Client firm'}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={r.isSystem ? 'neutral' : 'brand'}>
                      {r.isSystem ? 'built-in' : 'custom'}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.userCount}</td>
                  <td className="px-3 py-2 tabular-nums">{r.permissions.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
