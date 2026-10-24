import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { StagingBanner } from '@/components/staging-banner';
import { isStaging } from '@/lib/deploy';
import { siteUrl } from '@/lib/seo';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: 'Datascribe — Medical record review for law firms',
  description:
    'Medical indexes, chronologies and summaries for personal injury, med-mal and workers comp.',
  // staging is never indexed (D-123); the X-Robots-Tag header and robots.txt say so too
  ...(isStaging() ? { robots: { index: false, follow: false } } : {}),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-body antialiased">
        {isStaging() ? <StagingBanner /> : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
