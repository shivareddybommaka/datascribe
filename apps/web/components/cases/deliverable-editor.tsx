'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Badge, Button, Dialog, Empty, ErrorText, Input, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type {
  CaseWorkspace,
  ChronologyEntry,
  DeliverableContent,
  DeliverableVersion,
  IndexRow,
  WorkspaceDeliverable,
} from '@/lib/types';

export type EditableType = 'chronology' | 'index' | 'summary';

interface PageRef {
  documentId: string;
  pageNumber: number;
}

type Documents = CaseWorkspace['documents'];

/** Case and deliverable states the API accepts a save in (D-086); a UI hint only. */
export function isEditable(caseStatus: string, d: WorkspaceDeliverable | undefined): boolean {
  return (
    !!d &&
    ['in_review', 'changes_requested'].includes(caseStatus) &&
    ['draft', 'changes_requested'].includes(d.status) &&
    !d.lockedAt
  );
}

const versionsKey = (caseId: string, type: string) => ['deliverable-versions', caseId, type];

/** Save `content` as a new version on top of `baseVersion`; refreshes the workspace + history. */
function useSave(caseId: string, type: EditableType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { baseVersion: number; content: DeliverableContent }) =>
      api<WorkspaceDeliverable>(`/cases/${caseId}/deliverables/${type}`, {
        method: 'PUT',
        body: v as unknown as Record<string, unknown>,
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case-workspace', caseId] }),
        qc.invalidateQueries({ queryKey: versionsKey(caseId, type) }),
      ]);
    },
  });
}

const conflictCodes = ['version_conflict', 'deliverable_locked', 'case_not_editable'];
const isConflict = (e: unknown) => e instanceof ApiError && conflictCodes.includes(e.code);

/**
 * Inline editor of a draft deliverable (M6 part 3b, §5.4). Edits a local copy; Save stores it as a
 * new version (the API keeps every earlier one). A stale editor (someone saved meanwhile) gets the
 * 409 and reloads the latest version.
 */
export function DeliverableEditor({
  caseId,
  deliverable,
  documents,
  current,
  onCite,
  onDone,
}: {
  caseId: string;
  deliverable: WorkspaceDeliverable;
  documents: Documents;
  current: PageRef | null;
  onCite: (p: PageRef) => void;
  onDone: () => void;
}) {
  const type = deliverable.type as EditableType;
  const [draft, setDraft] = useState<DeliverableContent>(() =>
    structuredClone(deliverable.content),
  );
  const save = useSave(caseId, type);
  const qc = useQueryClient();
  const docName = (id: string) => documents.find((d) => d.id === id)?.fileName ?? 'document';
  const citeHere = () =>
    current && {
      documentId: current.documentId,
      fileName: docName(current.documentId),
      pageNumber: current.pageNumber,
    };

  const submit = () =>
    save.mutate({ baseVersion: deliverable.version, content: draft }, { onSuccess: onDone });
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ['case-workspace', caseId] });
    onDone();
  };

  let body: ReactNode;
  if (draft.kind === 'chronology') {
    const set = (i: number, patch: Partial<ChronologyEntry>) =>
      setDraft({
        ...draft,
        entries: draft.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)),
      });
    body = (
      <ol className="space-y-3">
        {draft.entries.map((e, i) => {
          const n = i + 1;
          return (
            <li key={e.eventId ?? `new-${i}`} className="space-y-2 rounded border border-line p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  type="date"
                  aria-label={`Entry ${n} date`}
                  value={e.date ?? ''}
                  onChange={(ev) => set(i, { date: ev.target.value || null })}
                />
                <Input
                  aria-label={`Entry ${n} event type`}
                  placeholder="Event type"
                  value={e.eventType ?? ''}
                  onChange={(ev) => set(i, { eventType: ev.target.value || null })}
                />
                <Input
                  aria-label={`Entry ${n} provider`}
                  placeholder="Provider"
                  value={e.provider ?? ''}
                  onChange={(ev) => set(i, { provider: ev.target.value || null })}
                />
                <Input
                  aria-label={`Entry ${n} facility`}
                  placeholder="Facility"
                  value={e.facility ?? ''}
                  onChange={(ev) => set(i, { facility: ev.target.value || null })}
                />
              </div>
              <Textarea
                aria-label={`Entry ${n} description`}
                rows={3}
                value={e.description}
                onChange={(ev) => set(i, { description: ev.target.value })}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {e.citation ? (
                  <button
                    type="button"
                    className="text-brand-700 hover:underline"
                    onClick={() => e.citation && onCite(e.citation)}
                  >
                    Source: {e.citation.fileName ?? docName(e.citation.documentId)}, page{' '}
                    {e.citation.pageNumber}
                  </button>
                ) : (
                  <Badge tone="red">No source citation</Badge>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!current}
                  onClick={() => set(i, { citation: citeHere() })}
                >
                  Cite viewed page
                </Button>
                {e.codes.length > 0 && <span>{e.codes.length} codes</span>}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-red-700"
                  aria-label={`Remove entry ${n}`}
                  onClick={() =>
                    setDraft({ ...draft, entries: draft.entries.filter((_, j) => j !== i) })
                  }
                >
                  Remove
                </Button>
              </div>
            </li>
          );
        })}
        <li>
          <Button
            size="sm"
            variant="secondary"
            disabled={!current}
            title={current ? undefined : 'Open a source page first'}
            onClick={() =>
              setDraft({
                ...draft,
                entries: [
                  ...draft.entries,
                  {
                    date: null,
                    provider: null,
                    facility: null,
                    eventType: null,
                    description: '',
                    codes: [],
                    citation: citeHere(),
                  },
                ],
              })
            }
          >
            Add entry citing the viewed page
          </Button>
        </li>
      </ol>
    );
  } else if (draft.kind === 'index') {
    const set = (i: number, patch: Partial<IndexRow>) =>
      setDraft({ ...draft, rows: draft.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const page = (v: string) => Math.max(1, Math.floor(Number(v) || 1));
    body = (
      <ol className="space-y-3">
        {draft.rows.map((r, i) => {
          const n = i + 1;
          return (
            <li key={i} className="space-y-2 rounded border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{r.fileName}</span>
                <span className="text-muted">pages</span>
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  aria-label={`Row ${n} first page`}
                  value={r.pageFrom}
                  onChange={(ev) => set(i, { pageFrom: page(ev.target.value) })}
                />
                <span className="text-muted">to</span>
                <Input
                  type="number"
                  min={1}
                  className="w-20"
                  aria-label={`Row ${n} last page`}
                  value={r.pageTo}
                  onChange={(ev) => set(i, { pageTo: page(ev.target.value) })}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-red-700"
                  aria-label={`Remove row ${n}`}
                  onClick={() => setDraft({ ...draft, rows: draft.rows.filter((_, j) => j !== i) })}
                >
                  Remove
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={`Row ${n} record type`}
                  placeholder="Record type"
                  value={r.recordType}
                  onChange={(ev) => set(i, { recordType: ev.target.value })}
                />
                <Input
                  aria-label={`Row ${n} providers`}
                  placeholder="Providers, comma separated"
                  value={r.providers.join(', ')}
                  onChange={(ev) =>
                    set(i, {
                      providers: ev.target.value
                        .split(',')
                        .map((p) => p.trim())
                        .filter(Boolean),
                    })
                  }
                />
                <Input
                  type="date"
                  aria-label={`Row ${n} first date`}
                  value={r.dateFrom ?? ''}
                  onChange={(ev) => set(i, { dateFrom: ev.target.value || null })}
                />
                <Input
                  type="date"
                  aria-label={`Row ${n} last date`}
                  value={r.dateTo ?? ''}
                  onChange={(ev) => set(i, { dateTo: ev.target.value || null })}
                />
              </div>
            </li>
          );
        })}
      </ol>
    );
  } else {
    const sections = draft.sections;
    const setSection = (i: number, s: (typeof sections)[number]) =>
      setDraft({ ...draft, sections: sections.map((x, j) => (j === i ? s : x)) });
    body = (
      <div className="space-y-4">
        {sections.map((s, i) => (
          <section key={i} className="space-y-2 rounded border border-line p-3">
            <Input
              aria-label={`Section ${i + 1} heading`}
              value={s.heading}
              onChange={(ev) => setSection(i, { ...s, heading: ev.target.value })}
            />
            {s.paragraphs.map((p, j) => (
              <div key={j} className="flex gap-2">
                <Textarea
                  aria-label={`Section ${i + 1} paragraph ${j + 1}`}
                  rows={4}
                  value={p}
                  onChange={(ev) =>
                    setSection(i, {
                      ...s,
                      paragraphs: s.paragraphs.map((x, k) => (k === j ? ev.target.value : x)),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-700"
                  aria-label={`Remove section ${i + 1} paragraph ${j + 1}`}
                  onClick={() =>
                    setSection(i, { ...s, paragraphs: s.paragraphs.filter((_, k) => k !== j) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSection(i, { ...s, paragraphs: [...s.paragraphs, ''] })}
            >
              Add paragraph
            </Button>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Editing version {deliverable.version}. Saving creates version {deliverable.version + 1};
        earlier versions are kept.
      </p>
      {body}
      <ErrorText error={save.error} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={submit} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save new version'}
        </Button>
        <Button variant="secondary" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        {isConflict(save.error) && (
          <Button variant="secondary" onClick={reload}>
            Discard and load the latest
          </Button>
        )}
      </div>
    </div>
  );
}

/** Version list with view and restore (restore = save that version's content as a new one). */
export function VersionHistory({
  caseId,
  latest,
  canRestore,
  render,
}: {
  caseId: string;
  latest: WorkspaceDeliverable;
  canRestore: boolean;
  render: (content: DeliverableContent) => ReactNode;
}) {
  const type = latest.type as EditableType;
  const versions = useQuery({
    queryKey: versionsKey(caseId, type),
    queryFn: () =>
      api<{ items: DeliverableVersion[] }>(`/cases/${caseId}/deliverables/${type}/versions`),
  });
  const [viewing, setViewing] = useState<number | null>(null);
  const shown = useQuery({
    queryKey: [...versionsKey(caseId, type), viewing],
    queryFn: () =>
      api<WorkspaceDeliverable>(`/cases/${caseId}/deliverables/${type}/versions/${viewing}`),
    enabled: viewing !== null,
  });
  const save = useSave(caseId, type);
  const restore = async (version: number) => {
    const v = await api<WorkspaceDeliverable>(
      `/cases/${caseId}/deliverables/${type}/versions/${version}`,
    );
    save.mutate({ baseVersion: latest.version, content: v.content });
  };

  return (
    <section aria-label="Version history" className="space-y-2 border-t border-line pt-3">
      <h3 className="text-sm font-semibold text-ink">Version history</h3>
      <ErrorText error={versions.error ?? save.error} />
      {versions.data?.items.length === 0 && <Empty>No versions.</Empty>}
      <ol className="space-y-1 text-sm">
        {versions.data?.items.map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">Version {v.version}</span>
            <span className="text-muted">
              {v.editedBy ? v.editedBy.name : 'Pipeline'} · {dateTime(v.createdAt)} ·{' '}
              {v.status.replace(/_/g, ' ')}
            </span>
            {v.version === latest.version && <Badge tone="brand">current</Badge>}
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`View version ${v.version}`}
                onClick={() => setViewing(v.version)}
              >
                View
              </Button>
              {canRestore && v.version !== latest.version && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Restore version ${v.version}`}
                  disabled={save.isPending}
                  onClick={() => void restore(v.version)}
                >
                  Restore
                </Button>
              )}
            </span>
          </li>
        ))}
      </ol>
      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={`Version ${viewing ?? ''}`}
      >
        <ErrorText error={shown.error} />
        <div className="max-h-[60vh] overflow-y-auto">
          {shown.data ? render(shown.data.content) : <p className="text-sm text-muted">Loading…</p>}
        </div>
      </Dialog>
    </section>
  );
}
