'use client';

import { CASE_TYPES, PRIORITIES } from '@datascribe/shared/constants';
import { useState, type FormEvent } from 'react';
import { Button, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import type { CaseDetail, Requestable } from '@/lib/types';
import { CASE_TYPE_LABEL, DELIVERABLE_LABEL, PRIORITY_LABEL } from './labels';

const REQUESTABLE: Requestable[] = ['index', 'chronology', 'summary'];

export interface CaseInput {
  matterName: string;
  reference: string | null;
  patientName: string;
  incidentDate: string | null;
  caseType: string;
  requested: Requestable[];
  priority: string;
  dueAt: string | null;
  notes: string | null;
}

/**
 * §5.3 case form (create and edit-while-draft). The API validates every field and returns the
 * message; the browser only checks what HTML can.
 */
export function CaseForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: CaseDetail;
  submitLabel: string;
  busy: boolean;
  error: unknown;
  onSubmit: (input: CaseInput) => void;
  onCancel?: () => void;
}) {
  const [requested, setRequested] = useState<Requestable[]>(
    initial?.requested ?? ['index', 'chronology', 'summary'],
  );
  const today = new Date().toISOString().slice(0, 10);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? '').trim();
    onSubmit({
      matterName: text('matterName'),
      reference: text('reference') || null,
      patientName: text('patientName'),
      incidentDate: text('incidentDate') || null,
      caseType: text('caseType'),
      requested,
      priority: text('priority'),
      dueAt: text('dueAt') || null,
      notes: text('notes') || null,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Matter name" htmlFor="matterName">
          <Input
            id="matterName"
            name="matterName"
            required
            maxLength={200}
            defaultValue={initial?.matterName}
          />
        </Field>
        <Field label="Case reference (optional)" htmlFor="reference">
          <Input
            id="reference"
            name="reference"
            maxLength={100}
            defaultValue={initial?.reference ?? ''}
          />
        </Field>
        <Field label="Patient / plaintiff name" htmlFor="patientName">
          <Input
            id="patientName"
            name="patientName"
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={initial?.patientName}
          />
        </Field>
        <Field label="Date of incident (optional)" htmlFor="incidentDate">
          <Input
            id="incidentDate"
            name="incidentDate"
            type="date"
            max={today}
            defaultValue={initial?.incidentDate?.slice(0, 10) ?? ''}
          />
        </Field>
        <Field label="Case type" htmlFor="caseType">
          <Select
            id="caseType"
            name="caseType"
            required
            defaultValue={initial?.caseType ?? 'personal_injury'}
          >
            {CASE_TYPES.map((t) => (
              <option key={t} value={t}>
                {CASE_TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Priority" htmlFor="priority">
          <Select id="priority" name="priority" defaultValue={initial?.priority ?? 'normal'}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due date (optional)" htmlFor="dueAt">
          <Input
            id="dueAt"
            name="dueAt"
            type="date"
            min={today}
            defaultValue={initial?.dueAt?.slice(0, 10) ?? ''}
          />
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-ink">Requested deliverables</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {REQUESTABLE.map((r) => (
            <label key={r} className="flex items-center gap-2 text-sm text-body">
              <input
                type="checkbox"
                checked={requested.includes(r)}
                onChange={(e) =>
                  setRequested((cur) =>
                    e.target.checked ? [...cur, r] : cur.filter((x) => x !== r),
                  )
                }
              />
              {DELIVERABLE_LABEL[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <Field label="Notes for Datascribe (optional)" htmlFor="notes">
        <Textarea
          id="notes"
          name="notes"
          rows={4}
          maxLength={5000}
          defaultValue={initial?.notes ?? ''}
        />
      </Field>
      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy || requested.length === 0}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
