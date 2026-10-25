'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AssignDialog } from '@/components/cases/assign-dialog';
import { ReportDownload } from '@/components/cases/report-download';
import { Badge, Button, Card, Empty, ErrorText, Field, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { CaseDetail, QaReviewItem } from '@/lib/types';

const qaKey = (caseId: string) => ['qa-reviews', caseId];

/** One QA decision: the API stores a row per reviewed version, written together in one go. */
interface Decision {
  key: string;
  result: QaReviewItem['result'];
  comments: string | null;
  createdAt: string;
  reviewer: QaReviewItem['reviewer'];
  versions: QaReviewItem['deliverable'][];
}

/** Rows come newest first; neighbours from the same reviewer, result and moment are one decision. */
function decisions(items: QaReviewItem[]): Decision[] {
  const out: Decision[] = [];
  for (const q of items) {
    const last = out[out.length - 1];
    if (
      last &&
      last.reviewer.id === q.reviewer.id &&
      last.result === q.result &&
      last.comments === q.comments &&
      Math.abs(Date.parse(last.createdAt) - Date.parse(q.createdAt)) < 5_000 &&
      !last.versions.some((v) => v.type === q.deliverable.type)
    ) {
      last.versions.push(q.deliverable);
    } else {
      out.push({ ...q, key: q.id, versions: [q.deliverable] });
    }
  }
  return out;
}

/**
 * §5.4 QA step in the staff workspace (M6 part 4b, D-089): who is assigned, Submit for QA for the
 * summarizer / editors, Approve or Request changes (comments required) for the case's QA reviewer,
 * and the QA history. Buttons follow the API's `can` hints; the routes check everything again.
 */
export function QaPanel({ c }: { c: CaseDetail }) {
  const qc = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [comments, setComments] = useState('');
  const [missing, setMissing] = useState(false);
  const history = useQuery({
    queryKey: qaKey(c.id),
    queryFn: () => api<{ items: QaReviewItem[] }>(`/cases/${c.id}/qa-reviews`),
  });
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['case-workspace', c.id] }),
      qc.invalidateQueries({ queryKey: ['deliverable-versions', c.id] }),
      qc.invalidateQueries({ queryKey: qaKey(c.id) }),
    ]);
  const submit = useMutation({
    mutationFn: () => api(`/cases/${c.id}/submit-qa`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: (result: QaReviewItem['result']) =>
      api(`/cases/${c.id}/qa`, {
        method: 'POST',
        body: { result, comments: comments.trim() || null },
      }),
    onSuccess: async () => {
      setComments('');
      await refresh();
    },
  });
  const a = c.assignees;
  const people: [string, { name: string } | null | undefined][] = [
    ['Case manager', a?.caseManager],
    ['Summarizer', a?.summarizer],
    ['QA reviewer', a?.qaReviewer],
  ];
  const list = decisions(history.data?.items ?? []);

  return (
    <Card className="space-y-4">
      <section
        aria-label="Assignees"
        className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm"
      >
        {people.map(([label, p]) => (
          <span key={label}>
            <span className="text-muted">{label}:</span>{' '}
            <span className="font-medium text-ink">{p?.name ?? '—'}</span>
          </span>
        ))}
        {c.can.assign && (
          <Button
            size="sm"
            variant="secondary"
            className="ml-auto"
            onClick={() => setAssigning(true)}
          >
            Assign
          </Button>
        )}
      </section>
      {assigning && a && (
        <AssignDialog
          row={{ id: c.id, number: c.number, ...a }}
          onClose={() => setAssigning(false)}
        />
      )}

      {c.can.downloadReport && <ReportDownload caseId={c.id} />}

      {c.can.submitQa && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            Submit for QA
          </Button>
          <span className="text-sm text-muted">
            Sends the latest version of each deliverable to the QA reviewer; no edits while in QA.
          </span>
        </div>
      )}
      <ErrorText error={submit.error} />

      {c.can.decideQa && (
        <form aria-label="QA decision" className="space-y-3" onSubmit={(e) => e.preventDefault()}>
          <Field
            label="QA comments"
            htmlFor="qa-comments"
            error={missing ? 'Say what needs to change' : undefined}
          >
            <Textarea
              id="qa-comments"
              rows={3}
              value={comments}
              aria-invalid={missing}
              onChange={(e) => {
                setComments(e.target.value);
                setMissing(false);
              }}
            />
          </Field>
          <div className="flex gap-3">
            <Button disabled={decide.isPending} onClick={() => decide.mutate('approved')}>
              Approve
            </Button>
            <Button
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => {
                if (!comments.trim()) setMissing(true);
                else decide.mutate('changes_requested');
              }}
            >
              Request changes
            </Button>
          </div>
          <ErrorText error={decide.error} />
        </form>
      )}

      <section aria-label="QA history" className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">QA history</h2>
        <ErrorText error={history.error} />
        {history.data && list.length === 0 && <Empty>Not reviewed yet.</Empty>}
        <ol className="space-y-2">
          {list.map((d) => (
            <li key={d.key} className="rounded border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={d.result === 'approved' ? 'green' : 'amber'}>
                  {d.result === 'approved' ? 'Approved' : 'Changes requested'}
                </Badge>
                <span className="text-muted">
                  {d.reviewer.name} · {dateTime(d.createdAt)} ·{' '}
                  {d.versions.map((v) => `${v.type} v${v.version}`).join(', ')}
                </span>
              </div>
              {d.comments && <p className="mt-2 whitespace-pre-wrap text-ink">{d.comments}</p>}
            </li>
          ))}
        </ol>
      </section>
    </Card>
  );
}
