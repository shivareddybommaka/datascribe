'use client';

import type { CaseStatus } from '@datascribe/shared/constants';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { AssignDialog } from '@/components/cases/assign-dialog';
import { CASE_STATUS_LABEL, CaseStatusBadge, PRIORITY_LABEL } from '@/components/portal/labels';
import { Badge, Button, Empty, ErrorText, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { Paged, StaffCaseRow } from '@/lib/types';

const PAGE = 50;
const QUEUE_STATUSES: CaseStatus[] = [
  'submitted',
  'processing',
  'in_review',
  'qa',
  'changes_requested',
  'approved',
  'on_hold',
  'delivered',
  'closed',
  'cancelled',
];

/** §5.4 staff case queue: filters, SLA flags (amber < 24 h, red overdue) and assignment (D-083). */
export default function CaseQueuePage() {
  const canAssign = useCan('cases:edit:all');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [assignee, setAssignee] = useState('');
  const [sla, setSla] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('due');
  const [offset, setOffset] = useState(0);
  const [assigning, setAssigning] = useState<StaffCaseRow | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort });
  if (q) params.set('q', q);
  if (status) params.set('status', status);
  else params.set('open', 'true');
  if (assignee.startsWith('unassigned:')) params.set('unassigned', assignee.slice(11));
  else if (assignee) params.set('assigneeId', assignee);
  if (sla) params.set('sla', sla);
  if (priority) params.set('priority', priority);
  const cases = useQuery({
    queryKey: ['case-queue', { q, status, assignee, sla, priority, sort, offset }],
    queryFn: () => api<Paged<StaffCaseRow>>(`/cases?${params}`),
    placeholderData: keepPreviousData,
  });
  const data = cases.data;
  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setOffset(0);
      set(v);
    };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold text-ink">Case queue</h1>

      <div className="flex flex-wrap items-end gap-3">
        <form
          role="search"
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            reset(setQ)(String(new FormData(e.currentTarget).get('q') ?? '').trim());
          }}
        >
          <Input
            name="q"
            aria-label="Case number, matter or reference"
            placeholder="Number, matter, reference"
            className="w-56"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <Select
          aria-label="Status"
          className="w-44"
          value={status}
          onChange={(e) => reset(setStatus)(e.target.value)}
        >
          <option value="">All open</option>
          {QUEUE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CASE_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Assignee"
          className="w-48"
          value={assignee}
          onChange={(e) => reset(setAssignee)(e.target.value)}
        >
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned:case_manager">No case manager</option>
          <option value="unassigned:summarizer">No summarizer</option>
          <option value="unassigned:qa_reviewer">No QA reviewer</option>
        </Select>
        <Select
          aria-label="SLA"
          className="w-40"
          value={sla}
          onChange={(e) => reset(setSla)(e.target.value)}
        >
          <option value="">Any due date</option>
          <option value="any">Flagged</option>
          <option value="red">Overdue</option>
          <option value="amber">Due in 24 h</option>
        </Select>
        <Select
          aria-label="Priority"
          className="w-36"
          value={priority}
          onChange={(e) => reset(setPriority)(e.target.value)}
        >
          <option value="">Any priority</option>
          {Object.entries(PRIORITY_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Sort"
          className="w-40"
          value={sort}
          onChange={(e) => reset(setSort)(e.target.value)}
        >
          <option value="due">Due date</option>
          <option value="priority">Priority</option>
          <option value="created">Newest</option>
        </Select>
      </div>

      <ErrorText error={cases.error} />
      {data?.items.length === 0 && <Empty>No cases match.</Empty>}
      {!!data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {[
                  'Number',
                  'Client',
                  'Matter',
                  'Status',
                  'Priority',
                  'Due',
                  'Case manager',
                  'Summarizer',
                  'QA',
                  '',
                ].map((h, i) => (
                  <th key={i} scope="col" className="px-3 py-2 font-medium">
                    {h || <span className="sr-only">Actions</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((c) => (
                <tr key={c.id} className="hover:bg-surface">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-ink">
                    <Link href={`/console/cases/${c.id}`} className="hover:underline">
                      {c.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{c.organization.name}</td>
                  <td className="px-3 py-2">{c.matterName}</td>
                  <td className="px-3 py-2">
                    <CaseStatusBadge status={c.status} />
                  </td>
                  <td className="px-3 py-2">{PRIORITY_LABEL[c.priority]}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {c.dueAt ? dateTime(c.dueAt) : '—'}{' '}
                    {c.sla === 'red' && <Badge tone="red">Overdue</Badge>}
                    {c.sla === 'amber' && <Badge tone="amber">Due soon</Badge>}
                  </td>
                  <td className="px-3 py-2">{c.caseManager?.name ?? '—'}</td>
                  <td className="px-3 py-2">{c.summarizer?.name ?? '—'}</td>
                  <td className="px-3 py-2">{c.qaReviewer?.name ?? '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {canAssign && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Assign ${c.number}`}
                        onClick={() => setAssigning(c)}
                      >
                        Assign
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center justify-end gap-3 text-sm text-muted">
          {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={offset + PAGE >= data.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </Button>
        </div>
      )}
      {assigning && <AssignDialog row={assigning} onClose={() => setAssigning(null)} />}
    </div>
  );
}
