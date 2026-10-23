import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import { siteUrl } from '@/lib/seo';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: 'Datascribe — Medical record review for law firms',
  description:
    'Medical indexes, chronologies and summaries for personal injury, med-mal and workers comp.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-body antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
