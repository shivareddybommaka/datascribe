import { DEFAULT_PAGES } from '@datascribe/site-content';
import { Suspense } from 'react';
import { pageMetadata } from '@/components/marketing/marketing-page';
import { Hero, Sections } from '@/components/marketing/sections';
import { getPage } from '@/lib/cms';
import { ContactForm } from './contact-form';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('contact');

// Copy comes from the CMS; the form posts to POST /api/v1/public/leads exactly as before (D-016).
export default async function ContactPage() {
  const page = await getPage('contact');
  const copy = page.contactForm ?? DEFAULT_PAGES.contact.contactForm!;
  return (
    <>
      <Hero hero={page.hero} compact />
      <section aria-label="Contact form" className="bg-white">
        <div className="mx-auto max-w-xl px-4 py-12 sm:px-6">
          <Suspense>
            <ContactForm copy={copy} />
          </Suspense>
        </div>
      </section>
      <Sections sections={page.sections} />
    </>
  );
}
