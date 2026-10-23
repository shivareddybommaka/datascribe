'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { CaseForm, type CaseInput } from '@/components/portal/case-form';
import {
  CASE_STATUS_LABEL,
  CASE_TYPE_LABEL,
  CaseStatusBadge,
  DELIVERABLE_LABEL,
  DocumentStateBadge,
  PRIORITY_LABEL,
  fileSize,
} from '@/components/portal/labels';
import { Uploader } from '@/components/portal/uploader';
import { Button, Card, Dialog, Empty, ErrorText, Field, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import type { CaseDetail, CaseMessage, DeliverableRow, DocumentRow, UserRef } from '@/lib/types';

export default function CaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const key = ['case', id];
  const kase = useQuery({ queryKey: key, queryFn: () => api<CaseDetail>(`/cases/${id}`) });
  const [editing, setEditing] = useState(false);

  const submit = useMutation({
    mutationFn: () => api<CaseDetail>(`/cases/${id}/submit`, { method: 'POST', body: {} }),
    onSuccess: (c) => {
      qc.setQueryData(key, c);
      void qc.invalidateQueries({ queryKey: ['cases'] });
    },
  });

  if (kase.error) return <ErrorText error={kase.error} />;
  if (!kase.data) return <p className="text-sm text-muted">Loading…</p>;
  const c = kase.data;

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/portal/cases" className="text-brand-700 hover:underline">
          ← Cases
        </Link>
      </nav>
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-ink">
            {c.matterName} <CaseStatusBadge status={c.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {c.number}
            {c.reference && ` · ${c.reference}`} · {c.organization.name}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {c.can.edit && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit case
            </Button>
          )}
          {c.can.submit && (
            <Button disabled={submit.isPending} onClick={() => submit.mutate()}>
              Submit to Datascribe
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={submit.error} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="text-base font-semibold text-ink">Details</h2>
          <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {(
              [
                ['Patient / plaintiff', c.patientName],
                ['Case type', CASE_TYPE_LABEL[c.caseType]],
                ['Date of incident', date(c.incidentDate)],
                ['Priority', PRIORITY_LABEL[c.priority]],
                ['Due', date(c.dueAt)],
                ['Requested', c.requested.map((r) => DELIVERABLE_LABEL[r]).join(', ')],
                ['Created by', `${c.createdBy.name}, ${date(c.createdAt)}`],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted">{label}</dt>
                <dd className="text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          {c.notes && (
            <div className="mt-4 text-sm">
              <p className="text-muted">Notes</p>
              <p className="whitespace-pre-wrap text-ink">{c.notes}</p>
            </div>
          )}
        </Card>
        <Card>
          <h2 className="text-base font-semibold text-ink">Status timeline</h2>
          <ol
            className="mt-3 space-y-3 border-l border-line pl-4 text-sm"
            aria-label="Status timeline"
          >
            {c.timeline.map((e, i) => (
              <li key={i}>
                <p className="font-medium text-ink">
                  {e.status ? CASE_STATUS_LABEL[e.status] : e.action}
                </p>
                <p className="text-xs text-muted">{dateTime(e.at)}</p>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <Documents caseDetail={c} />
      <Deliverables caseId={c.id} />
      {c.can.share && <Sharing caseDetail={c} />}
      <Messages caseId={c.id} />

      {editing && (
        <EditDialog
          caseDetail={c}
          onClose={() => setEditing(false)}
          onSaved={(fresh) => qc.setQueryData(key, fresh)}
        />
      )}
    </div>
  );
}

function EditDialog({
  caseDetail,
  onClose,
  onSaved,
}: {
  caseDetail: CaseDetail;
  onClose: () => void;
  onSaved: (c: CaseDetail) => void;
}) {
  const save = useMutation({
    mutationFn: (input: CaseInput) =>
      api<CaseDetail>(`/cases/${caseDetail.id}`, { method: 'PATCH', body: { ...input } }),
    onSuccess: (c) => {
      onSaved(c);
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Edit case">
      <CaseForm
        initial={caseDetail}
        submitLabel="Save changes"
        busy={save.isPending}
        error={save.error}
        onSubmit={(input) => save.mutate(input)}
        onCancel={onClose}
      />
    </Dialog>
  );
}

function Documents({ caseDetail: c }: { caseDetail: CaseDetail }) {
  const qc = useQueryClient();
  const key = ['case', c.id, 'documents'];
  const docs = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: DocumentRow[] }>(`/cases/${c.id}/documents`),
    // keep polling while a virus scan is running
    refetchInterval: (q) => (q.state.data?.items.some((d) => d.state === 'pending') ? 2000 : false),
  });
  const [error, setError] = useState<unknown>(null);
  // the case query key is a prefix of the documents key, so this refreshes both
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: ['case', c.id] }),
    [qc, c.id],
  );

  async function download(d: DocumentRow) {
    setError(null);
    try {
      const { url } = await api<{ url: string }>(`/documents/${d.id}/download-url`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      setError(e);
    }
  }
  const remove = useMutation({
    mutationFn: (d: DocumentRow) =>
      api(d.state === 'uploading' ? `/uploads/${d.id}` : `/documents/${d.id}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  });

  const items = docs.data?.items ?? [];
  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Records</h2>
      {c.can.upload && (
        <div className="mt-3">
          <Uploader caseId={c.id} onUploaded={refresh} />
        </div>
      )}
      <ErrorText error={docs.error ?? error ?? remove.error} />
      {items.length === 0 ? (
        <Empty>No records uploaded yet.</Empty>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Uploaded records</caption>
            <thead className="text-left text-muted">
              <tr>
                {['File', 'Status', 'Pages', 'Size', 'Uploaded', ''].map((h) => (
                  <th key={h} scope="col" className="px-2 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((d) => (
                <tr key={d.id}>
                  <td className="px-2 py-2">
                    <span className="font-medium text-ink">{d.fileName}</span>
                    {d.sha256 && (
                      <p className="font-mono text-xs text-muted" title={`SHA-256 ${d.sha256}`}>
                        SHA-256 {d.sha256.slice(0, 12)}…
                      </p>
                    )}
                    {d.state === 'uploading' && (
                      <p className="text-xs text-muted">
                        Incomplete. Choose the same file again to resume.
                      </p>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <DocumentStateBadge state={d.state} />
                  </td>
                  <td className="px-2 py-2 tabular-nums">{d.pageCount ?? '—'}</td>
                  <td className="px-2 py-2 tabular-nums">{fileSize(d.sizeBytes)}</td>
                  <td className="whitespace-nowrap px-2 py-2">
                    {d.uploadedAt ? dateTime(d.uploadedAt) : '—'}
                    <p className="text-xs text-muted">{d.uploadedBy.name}</p>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2 text-right">
                    {d.state === 'clean' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Download ${d.fileName}`}
                        onClick={() => download(d)}
                      >
                        Download
                      </Button>
                    )}
                    {(d.state === 'uploading' ? c.can.upload : c.can.deleteDocuments) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${d.fileName}`}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Remove ${d.fileName}?`)) remove.mutate(d);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Deliverables({ caseId }: { caseId: string }) {
  const list = useQuery({
    queryKey: ['case', caseId, 'deliverables'],
    queryFn: () => api<{ items: DeliverableRow[] }>(`/cases/${caseId}/deliverables`),
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Deliverables</h2>
      <ErrorText error={list.error} />
      {list.data?.items.length === 0 && (
        <Empty>Datascribe&apos;s index, chronology and summary appear here when delivered.</Empty>
      )}
      <ul className="mt-2 divide-y divide-line text-sm">
        {list.data?.items.map((d) => (
          <li key={d.id} className="flex gap-3 py-2">
            <span className="font-medium text-ink">
              {DELIVERABLE_LABEL[d.type]} v{d.version}
            </span>
            <span className="text-muted">{d.status.replace('_', ' ')}</span>
            <span className="ml-auto text-muted">{date(d.createdAt)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Sharing({ caseDetail: c }: { caseDetail: CaseDetail }) {
  const qc = useQueryClient();
  const candidates = useQuery({
    queryKey: ['case', c.id, 'share-candidates', c.shares.length],
    queryFn: () => api<{ items: UserRef[] }>(`/cases/${c.id}/share-candidates`),
  });
  const [userId, setUserId] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['case', c.id] });
  const share = useMutation({
    mutationFn: () => api(`/cases/${c.id}/shares`, { method: 'POST', body: { userId } }),
    onSuccess: async () => {
      setUserId('');
      await refresh();
    },
  });
  const unshare = useMutation({
    mutationFn: (u: UserRef) => api(`/cases/${c.id}/shares/${u.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Shared with</h2>
      <p className="mt-1 text-sm text-muted">
        Colleagues at your firm you share with can view the case, upload records and message
        Datascribe.
      </p>
      {c.shares.length === 0 ? (
        <Empty>Not shared with anyone yet.</Empty>
      ) : (
        <ul className="mt-3 divide-y divide-line text-sm">
          {c.shares.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2">
              <span className="text-ink">{u.name}</span>
              <span className="text-muted">{u.email}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={`Stop sharing with ${u.name}`}
                onClick={() => unshare.mutate(u)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (userId) share.mutate();
        }}
      >
        <Field label="Share with" htmlFor="share-user" className="w-72">
          <Select id="share-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose a colleague…</option>
            {candidates.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary" disabled={!userId || share.isPending}>
          Share
        </Button>
      </form>
      <ErrorText error={candidates.error ?? share.error ?? unshare.error} />
    </Card>
  );
}

function Messages({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const key = ['case', caseId, 'messages'];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<{ items: CaseMessage[] }>(`/cases/${caseId}/messages`),
    refetchInterval: 30_000,
  });
  const [body, setBody] = useState('');
  const send = useMutation({
    mutationFn: () => api(`/cases/${caseId}/messages`, { method: 'POST', body: { body } }),
    onSuccess: async () => {
      setBody('');
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <Card>
      <h2 className="text-base font-semibold text-ink">Messages with Datascribe</h2>
      <ErrorText error={list.error} />
      {list.data?.items.length === 0 && <Empty>No messages yet.</Empty>}
      <ol className="mt-3 space-y-3" aria-label="Messages">
        {list.data?.items.map((m) => (
          <li
            key={m.id}
            className={
              m.author.staff
                ? 'mr-12 rounded-lg bg-brand-50 px-4 py-3'
                : 'ml-12 rounded-lg bg-surface px-4 py-3'
            }
          >
            <p className="text-xs text-muted">
              {m.author.name}
              {m.author.staff && ' · Datascribe'} · {dateTime(m.createdAt)}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{m.body}</p>
          </li>
        ))}
      </ol>
      <form
        className="mt-4 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) send.mutate();
        }}
      >
        <Field label="Message to Datascribe" htmlFor="message-body">
          <Textarea
            id="message-body"
            rows={3}
            maxLength={5000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <ErrorText error={send.error} />
        <div className="flex justify-end">
          <Button type="submit" disabled={!body.trim() || send.isPending}>
            Send message
          </Button>
        </div>
      </form>
    </Card>
  );
}
