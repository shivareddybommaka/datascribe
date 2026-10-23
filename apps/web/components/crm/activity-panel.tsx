'use client';

import { ACTIVITY_TYPES, type ActivityType } from '@datascribe/shared/constants';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useCan } from '../auth';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Activity } from '@/lib/types';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Textarea } from '../ui';
import { useStaff } from './lead-form';

const TYPE_LABEL: Record<ActivityType, string> = {
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  note: 'Note',
  task: 'Task',
};

/** Timeline + "log activity" form for a lead or an account. */
export function ActivityPanel({
  activities,
  link,
  invalidate,
}: {
  activities: Activity[];
  link: { leadId?: string; organizationId?: string };
  invalidate: unknown[];
}) {
  const qc = useQueryClient();
  const canCreate = useCan('crm:create');
  const canEdit = useCan('crm:edit');
  const staff = useStaff();
  const [type, setType] = useState<ActivityType>('note');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: invalidate });
    void qc.invalidateQueries({ queryKey: ['my-tasks'] });
  };
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/activities', { method: 'POST', body }),
    onSuccess: refresh,
  });
  const toggle = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      api(`/activities/${id}`, { method: 'PATCH', body: { done } }),
    onSuccess: refresh,
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const due = String(f.get('dueAt') ?? '');
    create.mutate(
      {
        type,
        subject: String(f.get('subject') ?? '').trim(),
        body: String(f.get('body') ?? '').trim() || null,
        ...(type === 'task' && due ? { dueAt: new Date(due).toISOString() } : {}),
        ...(type === 'task' && f.get('userId') ? { userId: f.get('userId') } : {}),
        ...link,
      },
      { onSuccess: () => form.reset() },
    );
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Activity</h2>
      {canCreate && (
        <form
          onSubmit={onSubmit}
          className="mt-3 grid gap-3 rounded-md bg-surface p-3 sm:grid-cols-4"
        >
          <Field label="Type" htmlFor="act-type">
            <Select
              id="act-type"
              value={type}
              onChange={(e) => setType(e.target.value as ActivityType)}
            >
              {ACTIVITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Subject" htmlFor="act-subject" className="sm:col-span-3">
            <Input id="act-subject" name="subject" required maxLength={300} />
          </Field>
          {type === 'task' && (
            <>
              <Field label="Due" htmlFor="act-due" className="sm:col-span-2">
                <Input id="act-due" name="dueAt" type="datetime-local" required />
              </Field>
              <Field label="Assign to" htmlFor="act-user" className="sm:col-span-2">
                <Select id="act-user" name="userId">
                  <option value="">Me</option>
                  {staff.data?.items.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <Field label="Details (optional)" htmlFor="act-body" className="sm:col-span-4">
            <Textarea id="act-body" name="body" rows={2} />
          </Field>
          <div className="sm:col-span-4">
            <ErrorText error={create.error} />
            <Button type="submit" size="sm" disabled={create.isPending}>
              {type === 'task' ? 'Add task' : `Log ${TYPE_LABEL[type].toLowerCase()}`}
            </Button>
          </div>
        </form>
      )}
      <ErrorText error={toggle.error} />
      {activities.length === 0 && <Empty>No activity yet.</Empty>}
      <ol className="mt-4 space-y-3">
        {activities.map((a) => (
          <li key={a.id} className="flex gap-3 text-sm">
            <div className="w-20 shrink-0">
              <Badge tone={a.type === 'task' ? (a.doneAt ? 'green' : 'amber') : 'neutral'}>
                {TYPE_LABEL[a.type]}
              </Badge>
            </div>
            <div className="min-w-0 flex-1">
              <p className={a.type === 'task' && a.doneAt ? 'text-muted line-through' : 'text-ink'}>
                {a.subject}
              </p>
              {a.body && <p className="whitespace-pre-wrap text-body">{a.body}</p>}
              <p className="text-xs text-muted">
                {a.user?.name ?? ''} · {dateTime(a.createdAt)}
                {a.type === 'task' && a.dueAt && ` · due ${dateTime(a.dueAt)}`}
              </p>
            </div>
            {a.type === 'task' && canEdit && (
              <Button
                size="sm"
                variant="ghost"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ id: a.id, done: !a.doneAt })}
              >
                {a.doneAt ? 'Reopen' : 'Done'}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
