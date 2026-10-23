'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { LEAD_STAGES } from '@datascribe/shared/constants';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { api } from '@/lib/api';
import { SOURCE_LABEL, STAGE_LABEL, dateInputToIso, isoToDateInput } from '@/lib/format';
import type { Lead, UserRef } from '@/lib/types';
import { Button, ErrorText, Field, Input, Select, Textarea } from '../ui';

export const useStaff = () =>
  useQuery({
    queryKey: ['crm-staff'],
    queryFn: () => api<{ items: UserRef[] }>('/crm/staff'),
    staleTime: 5 * 60_000,
  });

// "won" is set by converting, so it isn't offered here.
const EDITABLE_STAGES = LEAD_STAGES.filter((s) => s !== 'won');

const Schema = z
  .object({
    companyName: z.string().trim().min(1, 'Required').max(200),
    contactName: z.string().trim().min(1, 'Required').max(200),
    email: z.union([z.literal(''), z.string().trim().email('Enter a valid email')]),
    phone: z.string().trim().max(40),
    source: z.string(),
    stage: z.enum(LEAD_STAGES),
    ownerId: z.string(),
    value: z.union([
      z.literal(''),
      z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Amount, e.g. 2500'),
    ]),
    currency: z.string().length(3),
    nextFollowUpAt: z.string(),
    lostReason: z.string().trim().max(500),
    notes: z.string().trim().max(5000),
  })
  .refine((v) => v.stage !== 'lost' || v.lostReason.length > 0, {
    path: ['lostReason'],
    message: 'A lost reason is required',
  });
type Values = z.infer<typeof Schema>;

const toValues = (l?: Lead): Values => ({
  companyName: l?.companyName ?? '',
  contactName: l?.contactName ?? '',
  email: l?.email ?? '',
  phone: l?.phone ?? '',
  source: l?.source ?? 'manual',
  stage: l?.stage ?? 'new',
  ownerId: l?.ownerId ?? '',
  value: l?.value ?? '',
  currency: l?.currency ?? 'USD',
  nextFollowUpAt: isoToDateInput(l?.nextFollowUpAt ?? null),
  lostReason: l?.lostReason ?? '',
  notes: l?.notes ?? '',
});

/** Values → API body. Blank optional fields become null; edits send only changed fields. */
function toBody(v: Values, initial?: Values): Record<string, unknown> {
  const body: Record<string, unknown> = {
    companyName: v.companyName,
    contactName: v.contactName,
    email: v.email || null,
    phone: v.phone || null,
    source: v.source,
    stage: v.stage,
    value: v.value || null,
    currency: v.currency,
    nextFollowUpAt: dateInputToIso(v.nextFollowUpAt),
    lostReason: v.lostReason || null,
    notes: v.notes || null,
    ...(v.ownerId ? { ownerId: v.ownerId } : {}),
  };
  if (!initial) return body;
  const before = toBody(initial);
  return Object.fromEntries(
    Object.entries(body).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(before[k])),
  );
}

export function LeadForm({
  lead,
  onSaved,
  onCancel,
}: {
  lead?: Lead;
  onSaved: (lead: Lead) => void;
  onCancel?: () => void;
}) {
  const staff = useStaff();
  const initial = toValues(lead);
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(Schema), defaultValues: initial });
  const stage = watch('stage');
  const converted = !!lead?.convertedOrgId;

  const submit = handleSubmit(async (v) => {
    try {
      const saved = lead
        ? await api<Lead>(`/leads/${lead.id}`, { method: 'PATCH', body: toBody(v, initial) })
        : await api<Lead>('/leads', { method: 'POST', body: toBody(v) });
      onSaved(saved);
    } catch (e) {
      setError('root', { message: e instanceof Error ? e.message : 'Could not save' });
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
      <Field label="Company" htmlFor="companyName" error={errors.companyName?.message}>
        <Input id="companyName" aria-invalid={!!errors.companyName} {...register('companyName')} />
      </Field>
      <Field label="Contact name" htmlFor="contactName" error={errors.contactName?.message}>
        <Input id="contactName" aria-invalid={!!errors.contactName} {...register('contactName')} />
      </Field>
      <Field label="Email" htmlFor="email" error={errors.email?.message}>
        <Input id="email" type="email" aria-invalid={!!errors.email} {...register('email')} />
      </Field>
      <Field label="Phone" htmlFor="phone">
        <Input id="phone" type="tel" {...register('phone')} />
      </Field>
      <Field label="Stage" htmlFor="stage">
        <Select id="stage" disabled={converted} {...register('stage')}>
          {(converted ? LEAD_STAGES : EDITABLE_STAGES).map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Source" htmlFor="source">
        <Select id="source" {...register('source')}>
          {Object.entries(SOURCE_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      {stage === 'lost' && (
        <Field
          label="Lost reason"
          htmlFor="lostReason"
          error={errors.lostReason?.message}
          className="sm:col-span-2"
        >
          <Input id="lostReason" aria-invalid={!!errors.lostReason} {...register('lostReason')} />
        </Field>
      )}
      <Field label="Owner" htmlFor="ownerId">
        <Select id="ownerId" {...register('ownerId')}>
          <option value="">{lead ? 'Unassigned' : 'Me'}</option>
          {staff.data?.items.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Next follow-up" htmlFor="nextFollowUpAt">
        <Input id="nextFollowUpAt" type="date" {...register('nextFollowUpAt')} />
      </Field>
      <Field label="Estimated value" htmlFor="value" error={errors.value?.message}>
        <Input
          id="value"
          inputMode="decimal"
          aria-invalid={!!errors.value}
          {...register('value')}
        />
      </Field>
      <Field label="Currency" htmlFor="currency">
        <Select id="currency" {...register('currency')}>
          <option value="USD">USD</option>
          <option value="INR">INR</option>
          <option value="AUD">AUD</option>
        </Select>
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
        <Textarea id="notes" rows={3} {...register('notes')} />
      </Field>
      <div className="sm:col-span-2">
        <ErrorText error={errors.root?.message ? new Error(errors.root.message) : null} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : lead ? 'Save changes' : 'Create lead'}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
