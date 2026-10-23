'use client';

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

export function ContactForm() {
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
      <p role="status" className="mt-8 rounded-md bg-brand-50 p-4 text-ink">
        Thanks, we&apos;ve received your message and will be in touch shortly.
      </p>
    );
  }

  return (
    <form
      noValidate
      className="mt-8 space-y-4"
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
      <Field label="I'd like to" htmlFor="kind">
        <Select id="kind" {...register('kind')}>
          <option value="demo">Book a demo</option>
          <option value="contact">Ask a question</option>
        </Select>
      </Field>
      <Field label="Your name" htmlFor="name" error={errors.name?.message}>
        <Input id="name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
      </Field>
      <Field label="Firm" htmlFor="company" error={errors.company?.message}>
        <Input
          id="company"
          autoComplete="organization"
          aria-invalid={!!errors.company}
          {...register('company')}
        />
      </Field>
      <Field label="Work email" htmlFor="email" error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          aria-invalid={!!errors.email}
          {...register('email')}
        />
      </Field>
      <Field label="Phone (optional)" htmlFor="phone">
        <Input id="phone" type="tel" autoComplete="tel" {...register('phone')} />
      </Field>
      <Field label="Message (optional)" htmlFor="message">
        <Textarea id="message" rows={4} {...register('message')} />
      </Field>
      {/* honeypot: hidden from people and screen readers; bots fill it in */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send'}
      </Button>
    </form>
  );
}
