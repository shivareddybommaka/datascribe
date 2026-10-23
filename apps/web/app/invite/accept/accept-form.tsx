'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button, ErrorText, Field, Input } from '@/components/ui';
import { api } from '@/lib/api';

const Schema = z
  .object({
    name: z.string().trim().min(1, 'Enter your name').max(200),
    password: z.string().min(12, 'Use at least 12 characters').max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Passwords do not match',
  });
type Values = z.infer<typeof Schema>;

export function AcceptInviteForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(Schema) });

  if (!token) return <p className="mt-6 text-sm text-red-800">This invite link is incomplete.</p>;
  if (done) {
    return (
      <p role="status" className="mt-6 rounded-md bg-green-50 p-4 text-sm text-green-900">
        Your account ({done}) is ready. You can sign in once the client portal opens; your
        Datascribe contact will let you know.
      </p>
    );
  }

  return (
    <form
      noValidate
      className="mt-6 space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setError(null);
        try {
          const res = await api<{ email: string }>(`/invites/${encodeURIComponent(token)}/accept`, {
            method: 'POST',
            body: { name: v.name, password: v.password },
          });
          setDone(res.email);
        } catch (e) {
          setError(e);
        }
      })}
    >
      <Field label="Your name" htmlFor="name" error={errors.name?.message}>
        <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
      </Field>
      <Field label="Password" htmlFor="password" error={errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.password}
          {...register('password')}
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={errors.confirm?.message}>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          aria-invalid={!!errors.confirm}
          {...register('confirm')}
        />
      </Field>
      <ErrorText error={error} />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
