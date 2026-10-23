'use client';

import type { ContactFormCopy } from '@datascribe/site-content';
import { zodResolver } from '@hookform/resolvers/zod';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
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

/** Labels and messages come from the CMS (Contact page → "Contact form copy"). */
export function ContactForm({ copy }: { copy: ContactFormCopy }) {
  const params = useSearchParams();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { kind: params.get('kind') === 'demo' ? 'demo' : 'contact', website: '' },
  });

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
        <Textarea id="message" rows={4} {...register('message')} />
      </Field>
      {/* honeypot: hidden from people and screen readers; bots fill it in */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? copy.sendingLabel : copy.submitLabel}
      </Button>
    </form>
  );
}
