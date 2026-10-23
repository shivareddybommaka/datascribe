import { Suspense } from 'react';
import { Logo } from '@/components/logo';
import { ResetForm } from './reset-form';

export const metadata = { title: 'Choose a new password — Datascribe', robots: { index: false } };

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-8 shadow-sm">
        <Logo height={36} />
        <h1 className="mt-6 text-xl font-semibold text-ink">Choose a new password</h1>
        <Suspense>
          <ResetForm />
        </Suspense>
      </div>
    </main>
  );
}
