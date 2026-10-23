'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { api, setAccessToken } from '@/lib/api';

type LoginResult =
  | { accessToken: string }
  | { mfaRequired: true; mfaToken: string }
  | { mfaSetupRequired: true; mfaToken: string };

type Step =
  | { kind: 'password' }
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'setup'; mfaToken: string; qrDataUrl: string; secret: string };

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next')?.startsWith('/console') ? params.get('next')! : '/console/crm';
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const done = (token: string) => {
    setAccessToken(token);
    router.replace(next);
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const res = await api<LoginResult>('/auth/login', {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });
      if ('accessToken' in res) return done(res.accessToken);
      if ('mfaRequired' in res) return setStep({ kind: 'mfa', mfaToken: res.mfaToken });
      const setup = await api<{ qrDataUrl: string; secret: string }>('/auth/mfa/setup', {
        method: 'POST',
        body: { mfaToken: res.mfaToken },
      });
      setStep({ kind: 'setup', mfaToken: res.mfaToken, ...setup });
    });
  }

  function onCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind === 'password') return;
    const code = String(new FormData(e.currentTarget).get('code') ?? '').replace(/\s/g, '');
    void run(async () => {
      const res = await api<{ accessToken: string }>('/auth/mfa/verify', {
        method: 'POST',
        body: { mfaToken: step.mfaToken, code },
      });
      done(res.accessToken);
    });
  }

  if (step.kind === 'password') {
    return (
      <form onSubmit={onPassword} className="mt-6 space-y-4">
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'}
        </Button>
        <a
          href="/forgot-password"
          className="block text-center text-sm text-brand-700 hover:underline"
        >
          Forgot password?
        </a>
      </form>
    );
  }

  return (
    <form onSubmit={onCode} className="mt-6 space-y-4">
      {step.kind === 'setup' ? (
        <div className="space-y-3 text-sm">
          <p className="text-body">
            Two-factor authentication is required for staff. Scan this code with an authenticator
            app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.
          </p>
          <img
            src={step.qrDataUrl}
            alt="Authenticator QR code"
            width={180}
            height={180}
            className="mx-auto"
          />
          <p className="text-muted">
            Can&apos;t scan? Key:{' '}
            <code className="break-all font-mono text-ink">{step.secret}</code>
          </p>
        </div>
      ) : (
        <p className="text-sm text-body">Enter the 6-digit code from your authenticator app.</p>
      )}
      <Field label="Authentication code" htmlFor="code">
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          autoFocus
        />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? 'Verifying…' : 'Verify'}
      </Button>
      <button
        type="button"
        className="w-full text-sm text-muted underline"
        onClick={() => setStep({ kind: 'password' })}
      >
        Start again
      </button>
    </form>
  );
}
