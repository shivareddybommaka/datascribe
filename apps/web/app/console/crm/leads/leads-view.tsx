'use client';

import { LEAD_STAGES, type LeadStage } from '@datascribe/shared/constants';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type DragEvent } from 'react';
import { useCan } from '@/components/auth';
import { CsvImport } from '@/components/crm/csv-import';
import { LeadForm } from '@/components/crm/lead-form';
import { Badge, Button, Dialog, Empty, ErrorText, Field, Input, Select, cn } from '@/components/ui';
import { api, downloadCsv } from '@/lib/api';
import { SOURCE_LABEL, STAGE_LABEL, date, money } from '@/lib/format';
import type { Lead, Paged } from '@/lib/types';

export const stageTone = (s: LeadStage) =>
  s === 'won'
    ? 'green'
    : s === 'lost'
      ? 'red'
      : s === 'proposal'
        ? 'amber'
        : s === 'new'
          ? 'brand'
          : 'neutral';

const BOARD_LIMIT = 500;

export function LeadsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const canCreate = useCan('crm:create');
  const canEdit = useCan('crm:edit');
  const canExport = useCan('crm:export');

  const view = params.get('view') === 'table' ? 'table' : 'board';
  const filters = {
    q: params.get('q') ?? '',
    stage: params.get('stage') ?? '',
    owner: params.get('owner') ?? '',
    source: params.get('source') ?? '',
  };
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`);
  };

  const query = new URLSearchParams({ limit: String(BOARD_LIMIT) });
  if (filters.q) query.set('q', filters.q);
  if (filters.stage) query.set('stage', filters.stage);
  if (filters.owner) query.set('ownerId', filters.owner);
  if (filters.source) query.set('source', filters.source);

  const leads = useQuery({
    queryKey: ['leads', query.toString()],
    queryFn: () => api<Paged<Lead>>(`/leads?${query.toString()}`),
    placeholderData: keepPreviousData,
  });

  const [creating, setCreating] = useState(false);
  const [losing, setLosing] = useState<Lead | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['leads'] });
    void qc.invalidateQueries({ queryKey: ['pipeline-summary'] });
  };

  const move = useMutation({
    mutationFn: ({
      id,
      stage,
      lostReason,
    }: {
      id: string;
      stage: LeadStage;
      lostReason?: string;
    }) =>
      api(`/leads/${id}`, {
        method: 'PATCH',
        body: { stage, ...(lostReason ? { lostReason } : {}) },
      }),
    onSuccess: refresh,
  });

  function onDrop(stage: LeadStage, lead: Lead) {
    if (lead.stage === stage || lead.convertedOrgId) return;
    if (stage === 'won') {
      router.push(`/console/crm/leads/${lead.id}?convert=1`);
      return;
    }
    if (stage === 'lost') {
      setLosing(lead);
      return;
    }
    move.mutate({ id: lead.id, stage });
  }

  const items = leads.data?.items ?? [];
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('limit');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold text-ink">Leads</h1>
        <div
          role="group"
          aria-label="View"
          className="flex rounded-md border border-line bg-white p-0.5"
        >
          {(['board', 'table'] as const).map((v) => (
            <button
              key={v}
              aria-pressed={view === v}
              onClick={() => setParam('view', v === 'board' ? '' : v)}
              className={cn(
                'rounded px-3 py-1 text-sm font-medium capitalize',
                view === v ? 'bg-brand-600 text-white' : 'text-body hover:bg-surface',
              )}
            >
              {v}
            </button>
          ))}
        </div>
        {canExport && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadCsv(`/leads/export?${exportQuery}`, 'leads.csv')}
          >
            Export CSV
          </Button>
        )}
        {canCreate && (
          <CsvImport
            path="/leads/import"
            columnsHint="companyName, contactName, email, phone, source, stage, value, currency, nextFollowUpAt, lostReason, notes, ownerEmail"
            onImported={refresh}
          />
        )}
        {canCreate && <Button onClick={() => setCreating(true)}>New lead</Button>}
      </div>

      <form
        role="search"
        className="flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setParam('q', String(new FormData(e.currentTarget).get('q') ?? '').trim());
        }}
      >
        <Input
          name="q"
          aria-label="Search leads"
          placeholder="Search company, contact, email"
          defaultValue={filters.q}
          className="w-64"
        />
        <Select
          aria-label="Stage"
          value={filters.stage}
          onChange={(e) => setParam('stage', e.target.value)}
          className="w-40"
        >
          <option value="">All stages</option>
          {LEAD_STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Owner"
          value={filters.owner}
          onChange={(e) => setParam('owner', e.target.value)}
          className="w-36"
        >
          <option value="">Any owner</option>
          <option value="me">Mine</option>
        </Select>
        <Select
          aria-label="Source"
          value={filters.source}
          onChange={(e) => setParam('source', e.target.value)}
          className="w-44"
        >
          <option value="">Any source</option>
          {Object.entries(SOURCE_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <ErrorText error={leads.error ?? move.error} />
      {leads.data && leads.data.total > items.length && (
        <p className="text-sm text-muted">
          Showing {items.length} of {leads.data.total}. Narrow the filters to see the rest.
        </p>
      )}

      {view === 'board' ? (
        <Board items={items} draggable={canEdit} onDrop={onDrop} />
      ) : (
        <LeadTable items={items} />
      )}
      {leads.data && items.length === 0 && <Empty>No leads match these filters.</Empty>}

      <Dialog open={creating} onClose={() => setCreating(false)} title="New lead">
        {creating && (
          <LeadForm
            onCancel={() => setCreating(false)}
            onSaved={(lead) => {
              setCreating(false);
              refresh();
              router.push(`/console/crm/leads/${lead.id}`);
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={!!losing}
        onClose={() => setLosing(null)}
        title={`Mark ${losing?.companyName ?? ''} as lost`}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('lostReason') ?? '').trim();
            if (!losing || !reason) return;
            move.mutate(
              { id: losing.id, stage: 'lost', lostReason: reason },
              { onSuccess: () => setLosing(null) },
            );
          }}
        >
          <Field label="Lost reason (required)" htmlFor="lost-reason">
            <Input id="lost-reason" name="lostReason" required autoFocus />
          </Field>
          <Button type="submit" variant="danger" disabled={move.isPending}>
            Mark lost
          </Button>
        </form>
      </Dialog>
    </div>
  );
}

function Board({
  items,
  draggable,
  onDrop,
}: {
  items: Lead[];
  draggable: boolean;
  onDrop: (stage: LeadStage, lead: Lead) => void;
}) {
  const [over, setOver] = useState<LeadStage | null>(null);
  const byId = new Map(items.map((l) => [l.id, l]));

  const drop = (stage: LeadStage) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const lead = byId.get(e.dataTransfer.getData('text/lead-id'));
    if (lead) onDrop(stage, lead);
  };

  return (
    <div className="grid gap-3 overflow-x-auto pb-2 [grid-template-columns:repeat(6,minmax(13rem,1fr))]">
      {LEAD_STAGES.map((stage) => {
        const col = items.filter((l) => l.stage === stage);
        const total = col.reduce((n, l) => n + Number(l.value ?? 0), 0);
        return (
          <section
            key={stage}
            aria-label={`${STAGE_LABEL[stage]} column`}
            onDragOver={(e) => {
              if (!draggable) return;
              e.preventDefault();
              setOver(stage);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={drop(stage)}
            className={cn(
              'min-h-40 rounded-lg border bg-white p-2',
              over === stage ? 'border-brand-500 ring-2 ring-brand-100' : 'border-line',
            )}
          >
            <header className="mb-2 flex items-baseline justify-between px-1">
              <h2 className="text-sm font-semibold text-ink">{STAGE_LABEL[stage]}</h2>
              <span className="text-xs text-muted tabular-nums">
                {col.length} · {money(total)}
              </span>
            </header>
            <ul className="space-y-2">
              {col.map((l) => (
                <li
                  key={l.id}
                  draggable={draggable && !l.convertedOrgId}
                  onDragStart={(e) => e.dataTransfer.setData('text/lead-id', l.id)}
                  className="rounded-md border border-line bg-surface p-2 text-sm"
                >
                  <Link
                    href={`/console/crm/leads/${l.id}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {l.companyName}
                  </Link>
                  <p className="text-xs text-muted">{l.contactName}</p>
                  <p className="mt-1 flex justify-between text-xs">
                    <span className="tabular-nums">{money(l.value, l.currency)}</span>
                    <span className="text-muted">{l.owner?.name ?? 'Unassigned'}</span>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function LeadTable({ items }: { items: Lead[] }) {
  if (items.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full text-sm">
        <thead className="bg-surface text-left text-muted">
          <tr>
            {[
              'Company',
              'Contact',
              'Stage',
              'Value',
              'Owner',
              'Source',
              'Next follow-up',
              'Updated',
            ].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((l) => (
            <tr key={l.id} className="hover:bg-surface">
              <td className="px-3 py-2">
                <Link
                  href={`/console/crm/leads/${l.id}`}
                  className="font-medium text-brand-700 hover:underline"
                >
                  {l.companyName}
                </Link>
              </td>
              <td className="px-3 py-2">{l.contactName}</td>
              <td className="px-3 py-2">
                <Badge tone={stageTone(l.stage)}>{STAGE_LABEL[l.stage]}</Badge>
              </td>
              <td className="px-3 py-2 tabular-nums">{money(l.value, l.currency)}</td>
              <td className="px-3 py-2">{l.owner?.name ?? '—'}</td>
              <td className="px-3 py-2">{SOURCE_LABEL[l.source] ?? l.source}</td>
              <td className="px-3 py-2">{date(l.nextFollowUpAt)}</td>
              <td className="px-3 py-2">{date(l.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
