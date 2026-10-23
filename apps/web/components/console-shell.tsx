'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { logout } from '@/lib/api';
import type { Me } from '@/lib/types';
import { ImpersonationBanner } from './admin/impersonation';
import { useMe } from './auth';
import { Logo } from './logo';
import { cn } from './ui';

interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
  /** permission-key prefix needed to see the item (UI hint only) */
  perm?: string;
}

/** Console sections; `modules` is a UI hint for who sees the tab (the API enforces access). */
const SECTIONS: { label: string; href: string; modules: string[]; items: NavItem[] }[] = [
  {
    label: 'CRM',
    href: '/console/crm',
    modules: ['crm'],
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
    modules: ['invoices'],
    items: [
      { href: '/console/finance', label: 'Overview', exact: true },
      { href: '/console/finance/invoices', label: 'Invoices' },
      { href: '/console/finance/subscriptions', label: 'Subscriptions' },
      { href: '/console/finance/plans', label: 'Plans' },
    ],
  },
  {
    label: 'Admin',
    href: '/console/admin',
    modules: ['users', 'system_settings', 'audit_log'],
    items: [
      { href: '/console/admin/users', label: 'Users', perm: 'users:view:' },
      { href: '/console/admin/roles', label: 'Roles', perm: 'users:view:' },
      { href: '/console/admin/organizations', label: 'Organizations', perm: 'users:view:all' },
      { href: '/console/admin/settings', label: 'Settings', perm: 'system_settings:view:' },
      { href: '/console/admin/audit', label: 'Audit log', perm: 'audit_log:view:' },
    ],
  },
];

const holds = (me: Me, prefix: string) => me.permissions.some((p) => p.startsWith(prefix));

export function ConsoleShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const visible = SECTIONS.filter((s) => s.modules.some((m) => holds(me, `${m}:view:`)));
  const section = SECTIONS.find((s) => pathname.startsWith(s.href)) ?? visible[0] ?? SECTIONS[0]!;
  const items = section.items.filter((i) => !i.perm || holds(me, i.perm));
  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    <div className="min-h-screen bg-surface">
      <ImpersonationBanner />
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
            {items.map((item) => {
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
            {!me.impersonation && (
              <button onClick={() => logout()} className="text-brand-700 hover:underline">
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
  );
}
