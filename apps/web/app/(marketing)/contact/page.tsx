import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SiteHeader } from '@/components/site-header';
import { ContactForm } from './contact-form';

export const metadata: Metadata = {
  title: 'Contact Datascribe — book a demo',
  description: 'Talk to Datascribe about medical record review for your firm.',
};

// Interim contact page (M7). M3 makes the copy CMS-editable; the form and API stay the same.
export default function ContactPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-3xl font-semibold tracking-tight text-ink">Talk to us</h1>
        <p className="mt-2 text-muted">
          Tell us about your firm and we&apos;ll get back to you within one business day.
        </p>
        <Suspense>
          <ContactForm />
        </Suspense>
      </main>
    </>
  );
}
