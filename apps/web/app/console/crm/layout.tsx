import type { ReactNode } from 'react';
import { RequireStaff } from '@/components/auth';
import { ConsoleShell } from '@/components/console-shell';

export const metadata = { title: 'CRM — Datascribe console', robots: { index: false } };

export default function CrmLayout({ children }: { children: ReactNode }) {
  return (
    <RequireStaff>
      <ConsoleShell>{children}</ConsoleShell>
    </RequireStaff>
  );
}
