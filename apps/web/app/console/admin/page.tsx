'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useMe } from '@/components/auth';
import { Empty } from '@/components/ui';

/** /console/admin → the first admin screen this user may open. */
export default function AdminIndex() {
  const me = useMe();
  const router = useRouter();
  const has = (prefix: string) => me.permissions.some((p) => p.startsWith(prefix));
  const target = has('users:view:')
    ? '/console/admin/users'
    : has('audit_log:view:')
      ? '/console/admin/audit'
      : has('system_settings:view:')
        ? '/console/admin/settings'
        : null;
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);
  return target ? null : <Empty>You don&apos;t have access to any admin screens.</Empty>;
}
