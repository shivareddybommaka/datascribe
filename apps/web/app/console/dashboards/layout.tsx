import type { ReactNode } from 'react';
import { RequireStaff } from '@/components/auth';
import { ConsoleShell } from '@/components/console-shell';

export const metadata = { title: 'Dashboards — Datascribe console', robots: { index: false } };

export default function DashboardsLayout({ children }: { children: ReactNode }) {
  return (
    <RequireStaff>
      <ConsoleShell>{children}</ConsoleShell>
    </RequireStaff>
  );
}
