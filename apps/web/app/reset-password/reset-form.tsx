'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

export function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!token) return <p className="mt-4 text-sm text-red-800">This reset link is incomplete.</p>;
  if (done) {
    return (
      <div role="status" className="mt-4 space-y-3 text-sm text-body">
        <p>Your password was changed and all sessions were signed out.</p>
        <Link href="/console/login" className="font-medium text-brand-700 underline">
          Sign in
        </Link>
      </div>
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get('password') ?? '');
    if (password !== String(f.get('confirm') ?? '')) {
      setError(new Error('Passwords do not match'));
      return;
    }
    if (password.length < 12) {
      setError(new Error('Use at least 12 characters'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" onSubmit={onSubmit} className="mt-6 space-y-4">
      <Field label="New password (12+ characters)" htmlFor="password">
        <Input id="password" name="password" type="password" autoComplete="new-password" required />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save new password'}
      </Button>
    </form>
  );
}
