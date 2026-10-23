import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import './globals.css';

export const metadata: Metadata = {
  title: 'Datascribe — Medical record review for law firms',
  description:
    'Medical indexes, chronologies and summaries for personal injury, med-mal and workers comp.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white font-sans text-body antialiased">
        <header className="border-b border-line bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Logo />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
