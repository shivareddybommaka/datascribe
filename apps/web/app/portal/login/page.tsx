import { Suspense } from 'react';
import { LoginForm } from '@/components/login-form';
import { Logo } from '@/components/logo';

export const metadata = { title: 'Sign in — Datascribe client portal', robots: { index: false } };

export default function PortalLoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-8 shadow-sm">
        <Logo height={36} />
        <h1 className="mt-6 text-xl font-semibold text-ink">Client portal sign in</h1>
        <p className="mt-1 text-sm text-muted">For law firms working with Datascribe.</p>
        <Suspense>
          <LoginForm surface="portal" />
        </Suspense>
      </div>
    </main>
  );
}
