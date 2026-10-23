'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Button, cn } from '@/components/ui';
import { ACCEPT, isAbort, rejectReason, uploadFile } from '@/lib/upload';
import type { UploadState } from '@/lib/types';
import { fileSize } from './labels';

type ItemStatus = 'queued' | 'uploading' | 'verifying' | 'done' | 'paused' | 'failed';

interface Item {
  key: string;
  file: File;
  status: ItemStatus;
  loaded: number;
  error?: string;
  result?: UploadState;
}

const STATUS_TEXT: Record<ItemStatus, string> = {
  queued: 'Waiting',
  uploading: 'Uploading',
  verifying: 'Checking file',
  done: 'Uploaded',
  paused: 'Paused',
  failed: 'Interrupted',
};

/**
 * §5.3 uploader: drag and drop or pick several PDFs/images/TIFFs (≤ 500 MB each), one progress bar
 * per file, pause and resume. Files upload one after another; each sends 3 parts in parallel.
 */
export function Uploader({ caseId, onUploaded }: { caseId: string; onUploaded: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (key: string, patch: Partial<Item>) =>
    setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const start = useCallback(
    async (item: Item) => {
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      running.current = item.key;
      update(item.key, { status: 'uploading', error: undefined });
      try {
        const result = await uploadFile(caseId, item.file, {
          signal: controller.signal,
          onProgress: (loaded) => update(item.key, { loaded }),
          onVerifying: () => update(item.key, { status: 'verifying' }),
        });
        update(item.key, { status: 'done', loaded: item.file.size, result });
        onUploaded();
      } catch (e) {
        if (isAbort(e)) update(item.key, { status: 'paused' });
        else {
          update(item.key, {
            status: 'failed',
            error: e instanceof Error ? e.message : 'Upload failed',
          });
          onUploaded(); // refresh the list: a rejected file disappears, a partial one shows
        }
      } finally {
        controllers.current.delete(item.key);
        running.current = null;
      }
    },
    [caseId, onUploaded],
  );

  // one file at a time: start the next queued item when nothing is running
  useEffect(() => {
    if (running.current) return;
    const next = items.find((i) => i.status === 'queued');
    if (next) void start(next);
  }, [items, start]);

  function add(files: FileList | File[]) {
    const fresh = Array.from(files).map((file) => {
      const reason = rejectReason(file);
      return {
        key: `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`,
        file,
        status: reason ? 'failed' : 'queued',
        loaded: 0,
        error: reason ?? undefined,
      } satisfies Item;
    });
    setItems((cur) => [...cur, ...fresh]);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-lg border-2 border-dashed px-6 py-8 text-center',
          dragging ? 'border-brand-600 bg-brand-50' : 'border-line bg-white',
        )}
      >
        <p className="text-sm text-body">Drag and drop medical records here, or</p>
        <div className="mt-2">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label="Add records"
            onChange={(e) => {
              if (e.target.files?.length) add(e.target.files);
              e.target.value = '';
            }}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          PDF, PNG, JPEG or TIFF, up to 500 MB each. Interrupted uploads resume where they stopped.
        </p>
      </div>

      {items.length > 0 && (
        <ul
          className="divide-y divide-line rounded-lg border border-line bg-white"
          aria-live="polite"
        >
          {items.map((item) => {
            const pct = item.file.size ? Math.round((item.loaded / item.file.size) * 100) : 0;
            return (
              <li key={item.key} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-ink">{item.file.name}</span>
                  <span className="text-muted">{fileSize(item.file.size)}</span>
                  <span
                    className={cn(
                      'text-xs',
                      item.status === 'failed' ? 'text-red-700' : 'text-muted',
                    )}
                  >
                    {STATUS_TEXT[item.status]}
                    {item.status === 'uploading' && ` ${pct}%`}
                    {item.status === 'done' &&
                      item.result?.scanStatus === 'pending' &&
                      ' · scanning'}
                  </span>
                  <span className="ml-auto flex gap-2">
                    {item.status === 'uploading' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => controllers.current.get(item.key)?.abort()}
                      >
                        Pause
                      </Button>
                    )}
                    {(item.status === 'paused' ||
                      (item.status === 'failed' && !rejectReason(item.file))) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => update(item.key, { status: 'queued' })}
                      >
                        Resume {item.file.name}
                      </Button>
                    )}
                    {['done', 'failed', 'paused'].includes(item.status) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Dismiss ${item.file.name}`}
                        onClick={() => setItems((cur) => cur.filter((i) => i.key !== item.key))}
                      >
                        ✕
                      </Button>
                    )}
                  </span>
                </div>
                {item.status !== 'failed' || item.loaded > 0 ? (
                  <div
                    role="progressbar"
                    aria-label={`Upload progress for ${item.file.name}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="h-2 overflow-hidden rounded-full bg-gray-100"
                  >
                    <div
                      className={cn(
                        'h-full transition-[width]',
                        item.status === 'failed' ? 'bg-red-600' : 'bg-brand-600',
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                ) : null}
                {item.error && (
                  <p role="alert" className="text-xs text-red-700">
                    {item.error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
