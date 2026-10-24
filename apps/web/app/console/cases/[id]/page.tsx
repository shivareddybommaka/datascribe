'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMe } from '@/components/auth';
import {
  DeliverableEditor,
  VersionHistory,
  isEditable,
} from '@/components/cases/deliverable-editor';
import { CaseStatusBadge } from '@/components/portal/labels';
import { Badge, Button, Card, Empty, ErrorText, Select, cn } from '@/components/ui';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type {
  CaseWorkspace,
  ChronologyEntry,
  DeliverableContent,
  DocumentPageText,
  WorkspaceDeliverable,
} from '@/lib/types';
import { useObjectUrl } from '@/lib/use-object-url';

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
 * Pages show as images with thumbnails (part 2b, D-085), or as extracted text. Drafts are edited
 * inline as new versions, with history and restore (part 3b, D-087).
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
                  key={tab}
                  caseId={data.case.id}
                  caseStatus={data.case.status}
                  documents={data.documents}
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
  const [view, setView] = useState<'image' | 'text'>('image');
  const base = current ? `/documents/${current.documentId}/pages/${current.pageNumber}` : null;
  const image = useObjectUrl(base && `${base}/image`, doc?.state === 'clean' && view === 'image');
  // no rendered image (TIFF, previews off, older case): the text is all there is
  const showText = view === 'text' || image.status === 'missing' || image.status === 'error';

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
                  <PageThumb
                    documentId={doc!.id}
                    pageNumber={n}
                    selected={n === current?.pageNumber}
                    onPick={() => onPick({ documentId: doc!.id, pageNumber: n })}
                  />
                </li>
              ))}
            </ol>
            <section
              aria-label={showText ? 'Page text' : 'Page image'}
              className="min-w-0 flex-1 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span className="font-medium text-ink">
                  Page {current?.pageNumber ?? '—'}
                  {doc?.pageCount ? ` of ${doc.pageCount}` : ''}
                </span>
                <div role="group" aria-label="Page view" className="flex gap-1">
                  {(['image', 'text'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={view === v}
                      onClick={() => setView(v)}
                      className={cn(
                        'rounded px-2 py-0.5 text-xs font-medium',
                        view === v ? 'bg-brand-100 text-brand-800' : 'hover:bg-surface',
                      )}
                    >
                      {v === 'image' ? 'Image' : 'Text'}
                    </button>
                  ))}
                </div>
                {page.data?.recordType && <Badge tone="neutral">{page.data.recordType}</Badge>}
                {page.data?.ocrConfidence != null && (
                  <Badge tone={page.data.ocrConfidence < 0.7 ? 'amber' : 'green'}>
                    OCR {Math.round(page.data.ocrConfidence * 100)}%
                  </Badge>
                )}
              </div>
              <ErrorText error={page.error} />
              {showText ? (
                <>
                  {view === 'image' && (
                    <p className="text-xs text-muted">
                      No page image for this file; showing the extracted text.
                    </p>
                  )}
                  <pre className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap rounded border border-line bg-surface p-3 text-sm text-ink">
                    {page.isLoading ? 'Loading…' : (page.data?.text ?? 'No text on this page.')}
                  </pre>
                </>
              ) : (
                <div className="max-h-[32rem] overflow-auto rounded border border-line bg-white">
                  {image.status === 'ready' ? (
                    // a blob URL (fetched with the bearer token), so not next/image
                    <img
                      src={image.url}
                      alt={`Page ${current?.pageNumber} of ${doc?.fileName ?? 'the document'}`}
                      className="w-full"
                    />
                  ) : (
                    <p className="p-3 text-sm text-muted">Loading…</p>
                  )}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </Card>
  );
}

/** A page button with its thumbnail, fetched only once it scrolls into view (300-page files). */
function PageThumb({
  documentId,
  pageNumber,
  selected,
  onPick,
}: {
  documentId: string;
  pageNumber: number;
  selected: boolean;
  onPick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const thumb = useObjectUrl(`/documents/${documentId}/pages/${pageNumber}/thumb`, seen);

  return (
    <button
      ref={ref}
      type="button"
      aria-current={selected ? 'page' : undefined}
      aria-label={`Page ${pageNumber}`}
      onClick={onPick}
      className={cn(
        'relative flex h-20 w-full items-center justify-center overflow-hidden rounded border text-sm',
        selected
          ? 'border-brand-600 bg-brand-100 text-brand-800'
          : 'border-line bg-surface text-muted hover:border-brand-600',
      )}
    >
      {thumb.status === 'ready' && (
        <img src={thumb.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
      )}
      <span
        className={cn(
          'relative',
          thumb.status === 'ready' && 'rounded bg-white/90 px-1 text-xs font-medium text-ink',
        )}
      >
        {pageNumber}
      </span>
    </button>
  );
}

/**
 * The latest version of one deliverable: read view, inline editor (part 3b, D-087) for staff with
 * `deliverables:edit` while the case is in review, and the version history with restore.
 */
function DeliverablePanel({
  caseId,
  caseStatus,
  deliverable,
  documents,
  current,
  onCite,
}: {
  caseId: string;
  caseStatus: string;
  deliverable: WorkspaceDeliverable | undefined;
  documents: CaseWorkspace['documents'];
  current: PageRef | null;
  onCite: (p: PageRef) => void;
}) {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  if (!deliverable) return <Empty>Not generated for this case.</Empty>;
  const canEdit =
    me.permissions.some((p) => p.startsWith('deliverables:edit:')) &&
    isEditable(caseStatus, deliverable);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          Version {deliverable.version} · {deliverable.status.replace(/_/g, ' ')}
          {deliverable.editedBy ? ` · edited by ${deliverable.editedBy.name}` : ''}
        </span>
        {canEdit && !editing && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
      </div>
      {editing && canEdit ? (
        <DeliverableEditor
          key={deliverable.id}
          caseId={caseId}
          deliverable={deliverable}
          documents={documents}
          current={current}
          onCite={onCite}
          onDone={() => setEditing(false)}
        />
      ) : (
        <DeliverableView content={deliverable.content} current={current} onCite={onCite} />
      )}
      {!editing && (
        <VersionHistory
          key={deliverable.type}
          caseId={caseId}
          latest={deliverable}
          canRestore={canEdit}
          render={(content) => <DeliverableView content={content} current={null} />}
        />
      )}
    </div>
  );
}

function DeliverableView({
  content: c,
  current,
  onCite,
}: {
  content: DeliverableContent;
  current: PageRef | null;
  /** Omitted in the version preview: citations there don't jump. */
  onCite?: (p: PageRef) => void;
}) {
  const isCurrent = (p: PageRef) =>
    current?.documentId === p.documentId && current.pageNumber === p.pageNumber;

  if (c.kind === 'chronology') {
    return (
      <>
        {c.entries.length === 0 && <Empty>No entries.</Empty>}
        <ol aria-label="Chronology entries" className="space-y-2">
          {c.entries.map((e: ChronologyEntry, i) => (
            <li key={e.eventId ?? i}>
              <button
                type="button"
                disabled={!e.citation || !onCite}
                onClick={() => e.citation && onCite?.(e.citation)}
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
                    disabled={!onCite}
                    onClick={() => onCite?.({ documentId: r.documentId, pageNumber: r.pageFrom })}
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
