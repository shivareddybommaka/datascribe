import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { AcceptInviteForm } from './accept-form';

export const metadata = { title: 'Accept invite — Datascribe', robots: { index: false } };

export default function AcceptInvitePage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-2xl font-semibold text-ink">Set up your Datascribe account</h1>
        <Suspense>
          <AcceptInviteForm />
        </Suspense>
      </main>
    </>
  );
}
