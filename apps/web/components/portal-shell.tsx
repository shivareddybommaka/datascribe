'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout } from '@/lib/api';
import { useMe } from './auth';
import { Logo } from './logo';
import { NotificationBell } from './notifications';
import { cn } from './ui';

/** `perm` is a UI hint for who sees the link (the API enforces access). */
const NAV: { href: string; label: string; perm?: string; exact?: boolean }[] = [
  { href: '/portal', label: 'Dashboard', exact: true },
  { href: '/portal/cases', label: 'Cases' },
  { href: '/portal/billing', label: 'Billing', perm: 'invoices:view:' },
  { href: '/portal/firm', label: 'Firm', perm: 'users:view:' },
];

export function PortalShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const items = NAV.filter((n) => !n.perm || me.permissions.some((p) => p.startsWith(n.perm!)));

  return (
    <div className="min-h-screen bg-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-8 gap-y-2 px-6 py-3">
          <Logo height={32} href="/portal" />
          <nav aria-label="Portal" className="flex gap-1">
            {items.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium',
                    active ? 'bg-brand-50 text-brand-700' : 'text-body hover:bg-surface',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <NotificationBell area="portal" />
            <span className="text-muted">{me.user.name}</span>
            <button onClick={() => logout()} className="text-brand-700 hover:underline">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-6 py-8">
        {children}
      </main>
    </div>
  );
}
