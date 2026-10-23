'use client';

import { CASE_STATUSES, CASE_TYPES } from '@datascribe/shared/constants';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import {
  CASE_STATUS_LABEL,
  CASE_TYPE_LABEL,
  CaseStatusBadge,
  PRIORITY_LABEL,
} from '@/components/portal/labels';
import { Button, Empty, ErrorText, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { CaseSummary, Paged } from '@/lib/types';

const PAGE = 25;

export default function CasesPage() {
  return (
    <Suspense>
      <CaseList />
    </Suspense>
  );
}

function CaseList() {
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const caseType = params.get('caseType') ?? '';
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0);
  const [text, setText] = useState(q);

  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) query.set('status', status);
  if (caseType) query.set('caseType', caseType);
  if (q) query.set('q', q);
  const cases = useQuery({
    queryKey: ['cases', query.toString()],
    queryFn: () => api<Paged<CaseSummary>>(`/cases?${query}`),
    placeholderData: keepPreviousData,
  });

  const go = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('offset' in patch)) next.delete('offset');
    router.replace(`/portal/cases?${next}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold text-ink">Cases</h1>
        <Link
          href="/portal/cases/new"
          className="ml-auto rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
        >
          New case
        </Link>
      </div>
      <form
        className="flex flex-wrap gap-2"
        role="search"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          go({ q: text.trim() });
        }}
      >
        <Input
          aria-label="Search matter, reference or case number"
          placeholder="Matter, reference or case number"
          className="w-72"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
        <Select
          aria-label="Status"
          className="w-48"
          value={status}
          onChange={(e) => go({ status: e.target.value })}
        >
          <option value="">Any status</option>
          {CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CASE_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Case type"
          className="w-48"
          value={caseType}
          onChange={(e) => go({ caseType: e.target.value })}
        >
          <option value="">Any type</option>
          {CASE_TYPES.map((t) => (
            <option key={t} value={t}>
              {CASE_TYPE_LABEL[t]}
            </option>
          ))}
        </Select>
      </form>

      <ErrorText error={cases.error} />
      {cases.data?.items.length === 0 && <Empty>No cases match.</Empty>}
      {!!cases.data?.items.length && (
        <div className="overflow-x-auto rounded-lg border border-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-muted">
              <tr>
                {['Case', 'Matter', 'Patient', 'Type', 'Priority', 'Status', 'Due', 'Created'].map(
                  (h) => (
                    <th key={h} scope="col" className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {cases.data.items.map((c) => (
                <tr key={c.id} className="hover:bg-surface">
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link
                      href={`/portal/cases/${c.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {c.number}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {c.matterName}
                    {c.reference && <p className="text-xs text-muted">{c.reference}</p>}
                  </td>
                  <td className="px-3 py-2">{c.patientName}</td>
                  <td className="px-3 py-2">{CASE_TYPE_LABEL[c.caseType]}</td>
                  <td className="px-3 py-2">{PRIORITY_LABEL[c.priority]}</td>
                  <td className="px-3 py-2">
                    <CaseStatusBadge status={c.status} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{date(c.dueAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{date(c.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cases.data && cases.data.total > PAGE && (
        <nav aria-label="Pages" className="flex items-center justify-end gap-3 text-sm">
          <span className="text-muted">
            {offset + 1}–{Math.min(offset + PAGE, cases.data.total)} of {cases.data.total}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset === 0}
            onClick={() => go({ offset: String(Math.max(0, offset - PAGE)) })}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={offset + PAGE >= cases.data.total}
            onClick={() => go({ offset: String(offset + PAGE) })}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}
