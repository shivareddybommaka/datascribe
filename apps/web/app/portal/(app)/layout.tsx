import type { ReactNode } from 'react';
import { RequireClient } from '@/components/auth';
import { PortalShell } from '@/components/portal-shell';

export const metadata = { title: 'Datascribe client portal', robots: { index: false } };

export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <RequireClient>
      <PortalShell>{children}</PortalShell>
    </RequireClient>
  );
}
