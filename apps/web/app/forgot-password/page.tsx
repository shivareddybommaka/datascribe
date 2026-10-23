'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Logo } from '@/components/logo';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot', {
        method: 'POST',
        body: { email: new FormData(e.currentTarget).get('email') },
      });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-8 shadow-sm">
        <Logo height={36} />
        <h1 className="mt-6 text-xl font-semibold text-ink">Reset your password</h1>
        {sent ? (
          <p role="status" className="mt-4 text-sm text-body">
            If an account exists for that email, a reset link is on its way. It expires in 1 hour.
          </p>
        ) : (
          <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4">
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" autoComplete="username" required />
            </Field>
            <ErrorText error={error} />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        )}
        <Link href="/console/login" className="mt-6 block text-sm text-brand-700 hover:underline">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
