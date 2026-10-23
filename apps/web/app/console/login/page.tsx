import { Suspense } from 'react';
import { Logo } from '@/components/logo';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — Datascribe console', robots: { index: false } };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-8 shadow-sm">
        <Logo height={36} />
        <h1 className="mt-6 text-xl font-semibold text-ink">Staff sign in</h1>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  );
}
