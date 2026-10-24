'use client';

import { useEffect, useState } from 'react';
import { fetchObjectUrl } from './api';

export type ObjectUrlState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'missing' }
  | { status: 'error'; error: Error };

/**
 * An authenticated image as an object URL (staff page viewer, D-085). Fetches when `path` is set
 * and `enabled`; revokes the URL when the path changes or the component unmounts, so page images
 * (PHI) don't linger in memory.
 */
export function useObjectUrl(path: string | null, enabled = true): ObjectUrlState {
  const [state, setState] = useState<ObjectUrlState>({ status: 'idle' });
  useEffect(() => {
    if (!path || !enabled) return;
    const ctrl = new AbortController();
    let url: string | null = null;
    setState({ status: 'loading' });
    fetchObjectUrl(path, ctrl.signal)
      .then((u) => {
        if (ctrl.signal.aborted) {
          // the cleanup already ran
          if (u) URL.revokeObjectURL(u);
          return;
        }
        url = u;
        setState(u ? { status: 'ready', url: u } : { status: 'missing' });
      })
      .catch((err: Error) => {
        if (!ctrl.signal.aborted) setState({ status: 'error', error: err });
      });
    return () => {
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, enabled]);
  return state;
}
