'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useMe } from '@/components/auth';
import { Button, Dialog, ErrorText, Field, Select } from '@/components/ui';
import { api } from '@/lib/api';
import type { AssignableStaff, AssignmentRole, StaffCaseRow } from '@/lib/types';

const ROLES: {
  role: AssignmentRole;
  field: 'caseManager' | 'summarizer' | 'qaReviewer';
  label: string;
}[] = [
  { role: 'case_manager', field: 'caseManager', label: 'Case manager' },
  { role: 'summarizer', field: 'summarizer', label: 'Summarizer' },
  { role: 'qa_reviewer', field: 'qaReviewer', label: 'QA reviewer' },
];

/**
 * Assign the case manager, summarizer and QA reviewer (§5.4, D-083). Without cases:manage the
 * case-manager picker only offers "me" or nobody; the API enforces the same rules.
 */
export function AssignDialog({
  row,
  onClose,
}: {
  row: Pick<StaffCaseRow, 'id' | 'number' | 'caseManager' | 'summarizer' | 'qaReviewer'>;
  onClose: () => void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const reassignAny = me.permissions.includes('cases:manage:all');
  const [values, setValues] = useState<Record<AssignmentRole, string>>({
    case_manager: row.caseManager?.id ?? '',
    summarizer: row.summarizer?.id ?? '',
    qa_reviewer: row.qaReviewer?.id ?? '',
  });
  const staff = useQuery({
    queryKey: ['assignable-staff'],
    queryFn: async () => {
      const lists = await Promise.all(
        ROLES.map((r) => api<AssignableStaff>(`/cases/assignable-staff?role=${r.role}`)),
      );
      return Object.fromEntries(lists.map((l) => [l.role, l.items])) as Record<
        AssignmentRole,
        AssignableStaff['items']
      >;
    },
  });
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string | null> = {};
      for (const r of ROLES) {
        const before = row[r.field]?.id ?? '';
        if (values[r.role] !== before) body[`${r.field}Id`] = values[r.role] || null;
      }
      return api(`/cases/${row.id}/assign`, { method: 'POST', body });
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['case-queue'] }),
        qc.invalidateQueries({ queryKey: ['case-workspace', row.id] }),
      ]);
      onClose();
    },
  });

  const options = (role: AssignmentRole) => {
    const list = staff.data?.[role] ?? [];
    if (role === 'case_manager' && !reassignAny) {
      return list.filter((p) => p.id === me.user.id || p.id === row.caseManager?.id);
    }
    return list;
  };

  return (
    <Dialog open onClose={onClose} title={`Assign ${row.number}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {ROLES.map((r) => (
          <Field key={r.role} label={r.label} htmlFor={`assign-${r.role}`}>
            <Select
              id={`assign-${r.role}`}
              value={values[r.role]}
              disabled={!staff.data}
              onChange={(e) => setValues({ ...values, [r.role]: e.target.value })}
            >
              <option value="">Nobody</option>
              {options(r.role).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.openCases} open)
                </option>
              ))}
            </Select>
          </Field>
        ))}
        <ErrorText error={staff.error ?? save.error} />
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending || !staff.data}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
