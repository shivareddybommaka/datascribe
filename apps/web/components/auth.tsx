'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, logout, onAuthChange, refreshSession } from '@/lib/api';
import type { Me } from '@/lib/types';

const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside <RequireStaff> / <RequireClient>');
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

/** §5.2: the portal signs out after 30 minutes without activity (the API enforces it too). */
export const PORTAL_IDLE_MS = 30 * 60 * 1000;

/**
 * Portal guard: restore the session, load /auth/me, and require a client-firm account. Staff are
 * sent to the console. Signs out after PORTAL_IDLE_MS without input, so PHI isn't left on screen.
 */
export function RequireClient({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const [restored, setRestored] = useState<boolean | null>(null);
  const toLogin = useCallback(
    (reason?: string) =>
      router.replace(
        `/portal/login?next=${encodeURIComponent(pathname)}${reason ? `&reason=${reason}` : ''}`,
      ),
    [router, pathname],
  );

  useEffect(() => {
    refreshSession().then((t) => setRestored(!!t));
    return onAuthChange((signedIn) => {
      if (!signedIn) {
        qc.clear();
        toLogin();
      }
    });
  }, [qc, toLogin]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void logout().finally(() => toLogin('idle'));
      }, PORTAL_IDLE_MS);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, arm));
    };
  }, [toLogin]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/auth/me'),
    enabled: restored === true,
  });

  useEffect(() => {
    if (restored === false) toLogin();
  }, [restored, toLogin]);
  useEffect(() => {
    if (me.data?.user.orgType === 'internal') router.replace('/console');
  }, [me.data, router]);

  if (restored === null || (restored && me.isPending)) {
    return <p className="p-10 text-sm text-muted">Loading…</p>;
  }
  if (!me.data || me.data.user.orgType !== 'client') return null;
  return <MeContext.Provider value={me.data}>{children}</MeContext.Provider>;
}
