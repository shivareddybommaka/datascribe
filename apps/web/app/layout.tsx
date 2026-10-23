import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Datascribe — Medical record review for law firms',
  description:
    'Medical indexes, chronologies and summaries for personal injury, med-mal and workers comp.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-brand-900 antialiased">{children}</body>
    </html>
  );
}
