'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout } from '@/lib/api';
import { useMe } from './auth';
import { Logo } from './logo';
import { cn } from './ui';

const NAV = [
  { href: '/console/crm', label: 'Overview', exact: true },
  { href: '/console/crm/leads', label: 'Leads' },
  { href: '/console/crm/accounts', label: 'Accounts' },
  { href: '/console/crm/contacts', label: 'Contacts' },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
          <Logo height={32} href="/console/crm" />
          <nav aria-label="CRM" className="flex gap-1">
            {NAV.map((item) => {
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
            <span className="text-muted" title={me.roles.join(', ')}>
              {me.user.name}
            </span>
            <button onClick={() => logout()} className="text-brand-700 hover:underline">
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
