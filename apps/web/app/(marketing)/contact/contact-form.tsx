'use client';

import type { ContactFormCopy } from '@datascribe/site-content';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';

const Schema = z.object({
  kind: z.enum(['contact', 'demo']),
  name: z.string().trim().min(1, 'Enter your name').max(200),
  company: z.string().trim().min(1, 'Enter your firm name').max(200),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().max(40).optional(),
  message: z.string().trim().max(5000).optional(),
  website: z.string().optional(), // honeypot
});
type Values = z.infer<typeof Schema>;

/**
 * Labels and messages come from the CMS (Contact page → "Contact form copy"). The form is in the
 * static HTML (no useSearchParams bailout, which shifted the page: Lighthouse CLS 0.4, D-127);
 * `?kind=demo` is applied after hydration, and Send stays disabled until then so the browser never
 * submits the fields natively into the URL.
 */
export function ContactForm({ copy }: { copy: ContactFormCopy }) {
  const [hydrated, setHydrated] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { kind: 'contact', website: '' },
  });

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('kind') === 'demo')
      setValue('kind', 'demo');
    setHydrated(true);
  }, [setValue]);

  if (sent) {
    return (
      <p role="status" className="rounded-md bg-brand-50 p-4 text-ink">
        {copy.successMessage}
      </p>
    );
  }

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={handleSubmit(async (v) => {
        setError(null);
        try {
          await api('/public/leads', { method: 'POST', body: v });
          setSent(true);
        } catch (e) {
          setError(e);
        }
      })}
    >
      <Field label={copy.kindLabel} htmlFor="kind">
        <Select id="kind" {...register('kind')}>
          <option value="demo">{copy.demoOption}</option>
          <option value="contact">{copy.contactOption}</option>
        </Select>
      </Field>
      <Field label={copy.nameLabel} htmlFor="name" error={errors.name?.message}>
        <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
      </Field>
      <Field label={copy.companyLabel} htmlFor="company" error={errors.company?.message}>
        <Input
          id="company"
          autoComplete="organization"
          aria-invalid={!!errors.company}
          {...register('company')}
        />
      </Field>
      <Field label={copy.emailLabel} htmlFor="email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          {...register('email')}
        />
      </Field>
      <Field label={copy.phoneLabel} htmlFor="phone">
        <Input id="phone" type="tel" autoComplete="tel" {...register('phone')} />
      </Field>
      <Field label={copy.messageLabel} htmlFor="message">
        <Textarea id="message" rows={4} aria-describedby="phi-notice" {...register('message')} />
      </Field>
      {/* Audit L6: fixed text, not CMS copy, so it can't be edited away. */}
      <p id="phi-notice" className="text-sm text-muted">
        Please don&apos;t include medical records, patient names or other health information in this
        form. Once your firm has an account, records are shared through the secure client portal.
      </p>
      {/* honeypot: hidden from people and screen readers; bots fill it in */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={!hydrated || isSubmitting}>
        {isSubmitting ? copy.sendingLabel : copy.submitLabel}
      </Button>
    </form>
  );
}
