'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaseForm, type CaseInput } from '@/components/portal/case-form';
import { Card } from '@/components/ui';
import { api } from '@/lib/api';
import type { CaseDetail } from '@/lib/types';

export default function NewCasePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (input: CaseInput) =>
      api<CaseDetail>('/cases', { method: 'POST', body: { ...input } }),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['cases'] });
      router.push(`/portal/cases/${c.id}`);
    },
  });
  return (
    <div className="space-y-5">
      <nav className="text-sm">
        <Link href="/portal/cases" className="text-brand-700 hover:underline">
          ← Cases
        </Link>
      </nav>
      <h1 className="text-2xl font-semibold text-ink">New case</h1>
      <p className="text-sm text-muted">
        The case starts as a draft. Upload the records, then submit it to Datascribe.
      </p>
      <Card>
        <CaseForm
          submitLabel="Create case"
          busy={create.isPending}
          error={create.error}
          onSubmit={(input) => create.mutate(input)}
          onCancel={() => router.push('/portal/cases')}
        />
      </Card>
    </div>
  );
}
