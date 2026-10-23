'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout } from '@/lib/api';
import { useMe } from './auth';
import { Logo } from './logo';
import { cn } from './ui';

interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}

/** Console sections; `module` is a UI hint for who sees the tab (the API enforces access). */
const SECTIONS: { label: string; href: string; module: string; items: NavItem[] }[] = [
  {
    label: 'CRM',
    href: '/console/crm',
    module: 'crm',
    items: [
      { href: '/console/crm', label: 'Overview', exact: true },
      { href: '/console/crm/leads', label: 'Leads' },
      { href: '/console/crm/accounts', label: 'Accounts' },
      { href: '/console/crm/contacts', label: 'Contacts' },
    ],
  },
  {
    label: 'Finance',
    href: '/console/finance',
    module: 'invoices',
    items: [
      { href: '/console/finance', label: 'Overview', exact: true },
      { href: '/console/finance/invoices', label: 'Invoices' },
      { href: '/console/finance/subscriptions', label: 'Subscriptions' },
      { href: '/console/finance/plans', label: 'Plans' },
    ],
  },
];

export function ConsoleShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const visible = SECTIONS.filter((s) =>
    me.permissions.some((p) => p.startsWith(`${s.module}:view:`)),
  );
  const section = SECTIONS.find((s) => pathname.startsWith(s.href)) ?? SECTIONS[0]!;
  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="min-h-screen bg-surface">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
          <Logo height={32} href={visible[0]?.href ?? '/console/crm'} />
          {visible.length > 1 && (
            <nav aria-label="Sections" className="flex gap-1 border-r border-line pr-6">
              {visible.map((s) => (
                <Link
                  key={s.href}
                  href={s.href}
                  aria-current={s === section ? 'true' : undefined}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-semibold',
                    s === section ? 'text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  {s.label}
                </Link>
              ))}
            </nav>
          )}
          <nav aria-label={section.label} className="flex gap-1">
            {section.items.map((item) => {
              const active = isActive(item);
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
