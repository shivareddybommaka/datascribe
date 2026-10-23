'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Dialog, ErrorText, Field, Input, Select, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { money2 } from '@/lib/format';
import type { Account, InvoiceDetail, Paged } from '@/lib/types';

interface Line {
  description: string;
  quantity: string;
  unitPrice: string;
}

const blankLine = (): Line => ({ description: '', quantity: '1', unitPrice: '' });

/** Finance: issue a one-off invoice (§5.6). Totals and tax are computed by the API. */
export function OneOffInvoiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['accounts', ''],
    queryFn: () => api<Paged<Account>>('/accounts?limit=500'),
    enabled: open,
  });
  const [orgId, setOrgId] = useState('');
  const [dueDays, setDueDays] = useState('14');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([blankLine()]);

  const org = accounts.data?.items.find((a) => a.id === orgId);
  const currency = org?.currency ?? 'USD';
  const subtotal = lines.reduce(
    (sum, l) => sum + Math.round(Number(l.quantity || 0) * Number(l.unitPrice || 0) * 100),
    0,
  );

  const create = useMutation({
    mutationFn: () =>
      api<InvoiceDetail>('/invoices', {
        method: 'POST',
        body: {
          organizationId: orgId,
          dueDays: Number(dueDays),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          lines: lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        },
      }),
    onSuccess: async (inv) => {
      await qc.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
      router.push(`/console/finance/invoices/${inv.id}`);
    },
  });

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <Dialog open={open} onClose={onClose} title="New one-off invoice">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Client" htmlFor="oo-org">
          <Select id="oo-org" required value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">Choose a firm…</option>
            {accounts.data?.items.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">Lines ({currency})</legend>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2">
              <Input
                aria-label={`Line ${i + 1} description`}
                placeholder="Description"
                required
                maxLength={300}
                value={l.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
              <Input
                aria-label={`Line ${i + 1} quantity`}
                inputMode="decimal"
                required
                className="w-20"
                value={l.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
              />
              <Input
                aria-label={`Line ${i + 1} unit price`}
                placeholder="Unit price"
                inputMode="decimal"
                required
                className="w-28"
                value={l.unitPrice}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              />
              {lines.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove line ${i + 1}`}
                  className="h-10"
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                >
                  ✕
                </Button>
              )}
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setLines((ls) => [...ls, blankLine()])}
          >
            Add line
          </Button>
        </fieldset>

        <div className="flex gap-4">
          <Field label="Due in (days)" htmlFor="oo-due" className="w-32">
            <Input
              id="oo-due"
              type="number"
              min={0}
              max={120}
              value={dueDays}
              onChange={(e) => setDueDays(e.target.value)}
            />
          </Field>
          <p className="ml-auto self-end text-sm text-muted">
            Subtotal{' '}
            <span className="font-medium text-ink">{money2(subtotal / 100, currency)}</span> + tax
          </p>
        </div>
        <Field label="Notes (shown on the invoice)" htmlFor="oo-notes">
          <Textarea
            id="oo-notes"
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || !orgId}>
            Issue invoice
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
