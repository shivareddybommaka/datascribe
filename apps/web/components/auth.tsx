'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, logout, onAuthChange, refreshSession } from '@/lib/api';
import type { Me } from '@/lib/types';

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside <RequireStaff>');
  return me;
}

/** UI hint only — the API enforces every permission (§0 rule 3). */
export function useCan(key: string): boolean {
  const me = useMe();
  return me.permissions.some((p) => p.startsWith(`${key}:`) || p === key);
}

/**
 * Console guard: restore the session from the refresh cookie, load /auth/me, require an internal
 * (staff) account, otherwise send to /console/login.
 */
export function RequireStaff({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [restored, setRestored] = useState<boolean | null>(null);

  useEffect(() => {
    refreshSession().then((t) => setRestored(!!t));
    return onAuthChange((signedIn) => {
      if (!signedIn) {
        qc.clear();
        router.replace(`/console/login?next=${encodeURIComponent(pathname)}`);
      }
    });
  }, [qc, router, pathname]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    enabled: restored === true,
  });

  useEffect(() => {
    if (restored === false) router.replace(`/console/login?next=${encodeURIComponent(pathname)}`);
  }, [restored, router, pathname]);

  if (restored === null || (restored && me.isPending)) {
    return <p className="p-10 text-sm text-muted">Loading…</p>;
  }
  if (me.data && me.data.user.orgType !== 'internal') {
    return (
      <div className="mx-auto max-w-md p-10 text-sm">
        <p className="text-ink">The staff console is for Datascribe staff only.</p>
        <button className="mt-4 text-brand-700 underline" onClick={() => logout()}>
          Sign out
        </button>
      </div>
    );
  }
  if (!me.data) return null;
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}
