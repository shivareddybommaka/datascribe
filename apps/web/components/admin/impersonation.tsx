'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, refreshSession, setAccessToken } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useMe } from '../auth';
import { Button } from '../ui';

/**
 * §4.4 read-only impersonation. The impersonation token lives in memory only (no cookie), so a
 * reload, "Stop" or its 15-minute expiry all fall back to the super admin's own session.
 */
export function useImpersonation() {
  const qc = useQueryClient();
  const router = useRouter();
  return {
    async start(userId: string) {
      const res = await api<{ accessToken: string }>(`/admin/impersonate/${userId}`, {
        method: 'POST',
      });
      setAccessToken(res.accessToken);
      // every cached answer belonged to the super admin: drop and refetch as the client user
      await qc.resetQueries();
      router.push('/console/admin/users');
    },
    async stop() {
      try {
        await api('/admin/impersonate/stop', { method: 'POST' });
      } finally {
        // back to the super admin's own session (refresh cookie)
        await refreshSession();
        await qc.resetQueries();
        router.push('/console/admin/users');
      }
    },
  };
}

export function ImpersonationBanner() {
  const me = useMe();
  const { stop } = useImpersonation();
  const [busy, setBusy] = useState(false);
  if (!me.impersonation) return null;
  const imp = me.impersonation;
  return (
    <div
      role="region"
      aria-label="Impersonation"
      className="border-b-2 border-amber-500 bg-amber-100 text-amber-950"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm">
        <p>
          <strong>
            Viewing as {me.user.name} ({imp.organization.name}), read-only.
          </strong>{' '}
          Signed in as {imp.by.name}. Changes are blocked; this view ends at{' '}
          {dateTime(imp.expiresAt)}.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await stop().finally(() => setBusy(false));
          }}
        >
          Stop viewing as {me.user.name}
        </Button>
      </div>
    </div>
  );
}
