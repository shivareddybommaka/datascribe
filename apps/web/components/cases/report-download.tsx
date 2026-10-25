'use client';

import { useState } from 'react';
import { Button, ErrorText } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * Download the delivered report PDF (M6 part 5b, D-099), for the client portal and the staff
 * workspace. The API signs a 5-minute URL per click and audits it.
 */
export function ReportDownload({ caseId }: { caseId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    setError(null);
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>(`/cases/${caseId}/report/download-url`);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <Button onClick={download} disabled={busy}>
        Download report
      </Button>
      <ErrorText error={error} />
    </div>
  );
}
