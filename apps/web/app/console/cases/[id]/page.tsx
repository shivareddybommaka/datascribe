'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CaseStatusBadge } from '@/components/portal/labels';
import { Badge, Card, Empty, ErrorText, Select, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type {
  CaseWorkspace,
  ChronologyEntry,
  DocumentPageText,
  WorkspaceDeliverable,
} from '@/lib/types';

type Tab = 'chronology' | 'index' | 'summary';
const TABS: { key: Tab; label: string }[] = [
  { key: 'chronology', label: 'Chronology' },
  { key: 'index', label: 'Index' },
  { key: 'summary', label: 'Summary' },
];

interface PageRef {
  documentId: string;
  pageNumber: number;
}

/**
 * §5.4 staff workspace (M6 part 2, D-084): source documents on the left, extracted data and the
 * draft deliverables on the right; a chronology entry or index row jumps to its source page.
 */
export default function CaseWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const ws = useQuery({
    queryKey: ['case-workspace', id],
    queryFn: () => api<CaseWorkspace>(`/cases/${id}/workspace`),
  });
  const [tab, setTab] = useState<Tab>('chronology');
  const [picked, setPicked] = useState<PageRef | null>(null);

  const data = ws.data;
  const viewable = data?.documents.filter((d) => d.state === 'clean') ?? [];
  const current: PageRef | null =
    picked ?? (viewable[0] ? { documentId: viewable[0].id, pageNumber: 1 } : null);
  const deliverable = (type: Tab) => data?.deliverables.find((d) => d.type === type);

  return (
    <div className="space-y-5">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/console/cases" className="hover:underline">
          Case queue
        </Link>{' '}
        / {data?.case.number ?? '…'}
      </nav>
      <ErrorText error={ws.error} />
      {data && (
        <>
          <header className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-ink">
              {data.case.number} · {data.case.matterName}
            </h1>
            <CaseStatusBadge status={data.case.status} />
            <span className="text-sm text-muted">
              {data.case.organization.name} · Patient {data.case.patientName}
            </span>
          </header>

          <div className="grid gap-5 lg:grid-cols-2">
            <DocumentViewer documents={data.documents} current={current} onPick={setPicked} />

            <Card className="min-w-0 space-y-4">
              <div role="tablist" aria-label="Deliverables" className="flex gap-2">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.key}
                    onClick={() => setTab(t.key)}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium',
                      tab === t.key ? 'bg-brand-100 text-brand-800' : 'text-muted hover:bg-surface',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)!.label}>
                <DeliverablePanel
                  deliverable={deliverable(tab)}
                  current={current}
                  onCite={setPicked}
                />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function DocumentViewer({
  documents,
  current,
  onPick,
}: {
  documents: CaseWorkspace['documents'];
  current: PageRef | null;
  onPick: (p: PageRef) => void;
}) {
  const doc = documents.find((d) => d.id === current?.documentId);
  const page = useQuery({
    queryKey: ['document-page', current?.documentId, current?.pageNumber],
    queryFn: () =>
      api<DocumentPageText>(`/documents/${current!.documentId}/pages/${current!.pageNumber}`),
    enabled: !!current && doc?.state === 'clean',
  });
  const pages = Array.from({ length: doc?.pageCount ?? 0 }, (_, i) => i + 1);

  return (
    <Card className="min-w-0 space-y-4">
      <h2 className="text-lg font-semibold text-ink">Source records</h2>
      {documents.length === 0 ? (
        <Empty>No records uploaded.</Empty>
      ) : (
        <>
          <Select
            aria-label="Document"
            value={current?.documentId ?? ''}
            onChange={(e) => onPick({ documentId: e.target.value, pageNumber: 1 })}
          >
            {documents.map((d) => (
              <option key={d.id} value={d.id} disabled={d.state !== 'clean'}>
                {d.fileName}
                {d.state === 'purged' ? ' (deleted by retention)' : ''}
                {d.pageCount ? ` · ${d.pageCount} pages` : ''}
              </option>
            ))}
          </Select>
          <div className="flex gap-4">
            <ol
              aria-label="Pages"
              className="flex max-h-[32rem] w-20 shrink-0 flex-col gap-2 overflow-y-auto"
            >
              {pages.map((n) => (
                <li key={n}>
                  <button
                    type="button"
                    aria-current={n === current?.pageNumber ? 'page' : undefined}
                    aria-label={`Page ${n}`}
                    onClick={() => onPick({ documentId: doc!.id, pageNumber: n })}
                    className={cn(
                      'flex h-20 w-full items-center justify-center rounded border text-sm',
                      n === current?.pageNumber
                        ? 'border-brand-600 bg-brand-100 text-brand-800'
                        : 'border-line bg-surface text-muted hover:border-brand-600',
                    )}
                  >
                    {n}
                  </button>
                </li>
              ))}
            </ol>
            <section aria-label="Page text" className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span className="font-medium text-ink">
                  Page {current?.pageNumber ?? '—'}
                  {doc?.pageCount ? ` of ${doc.pageCount}` : ''}
                </span>
                {page.data?.recordType && <Badge tone="neutral">{page.data.recordType}</Badge>}
                {page.data?.ocrConfidence != null && (
                  <Badge tone={page.data.ocrConfidence < 0.7 ? 'amber' : 'green'}>
                    OCR {Math.round(page.data.ocrConfidence * 100)}%
                  </Badge>
                )}
              </div>
              <ErrorText error={page.error} />
              <pre className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded border border-line bg-surface p-3 text-sm text-ink">
                {page.isLoading ? 'Loading…' : (page.data?.text ?? 'No text on this page.')}
              </pre>
            </section>
          </div>
        </>
      )}
    </Card>
  );
}

function DeliverablePanel({
  deliverable,
  current,
  onCite,
}: {
  deliverable: WorkspaceDeliverable | undefined;
  current: PageRef | null;
  onCite: (p: PageRef) => void;
}) {
  if (!deliverable) return <Empty>Not generated for this case.</Empty>;
  const c = deliverable.content;
  const meta = (
    <p className="mb-3 text-xs text-muted">
      Version {deliverable.version} · {deliverable.status.replace(/_/g, ' ')}
    </p>
  );
  const isCurrent = (p: PageRef) =>
    current?.documentId === p.documentId && current.pageNumber === p.pageNumber;

  if (c.kind === 'chronology') {
    return (
      <>
        {meta}
        {c.entries.length === 0 && <Empty>No entries.</Empty>}
        <ol className="space-y-2">
          {c.entries.map((e: ChronologyEntry, i) => (
            <li key={e.eventId ?? i}>
              <button
                type="button"
                disabled={!e.citation}
                onClick={() => e.citation && onCite(e.citation)}
                className={cn(
                  'w-full rounded border p-3 text-left text-sm',
                  e.citation && isCurrent(e.citation)
                    ? 'border-brand-600 bg-brand-100'
                    : 'border-line hover:border-brand-600',
                )}
              >
                <span className="font-medium text-ink">{date(e.date)}</span>
                {e.eventType && <span className="text-muted"> · {e.eventType}</span>}
                {(e.provider || e.facility) && (
                  <span className="text-muted">
                    {' '}
                    · {[e.provider, e.facility].filter(Boolean).join(', ')}
                  </span>
                )}
                <span className="mt-1 block text-ink">{e.description}</span>
                <span className="mt-1 block text-xs text-muted">
                  {e.citation ? (
                    `Source: ${e.citation.fileName ?? 'document'}, page ${e.citation.pageNumber}`
                  ) : (
                    <Badge tone="red">No source citation</Badge>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </>
    );
  }

  if (c.kind === 'index') {
    return (
      <>
        {meta}
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              {['Pages', 'Type', 'Providers', 'Dates'].map((h) => (
                <th key={h} scope="col" className="px-2 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {c.rows.map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1">
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={() => onCite({ documentId: r.documentId, pageNumber: r.pageFrom })}
                  >
                    {r.fileName} p. {r.pageFrom}
                    {r.pageTo !== r.pageFrom ? `–${r.pageTo}` : ''}
                  </button>
                </td>
                <td className="px-2 py-1">{r.recordType}</td>
                <td className="px-2 py-1">{r.providers.join(', ') || '—'}</td>
                <td className="whitespace-nowrap px-2 py-1">
                  {date(r.dateFrom)}
                  {r.dateTo && r.dateTo !== r.dateFrom ? ` – ${date(r.dateTo)}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  }

  return (
    <>
      {meta}
      <div className="space-y-4 text-sm">
        {c.sections.map((s, i) => (
          <section key={i}>
            <h3 className="font-semibold text-ink">{s.heading}</h3>
            {s.paragraphs.map((p, j) => (
              <p key={j} className="mt-1 text-ink">
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
