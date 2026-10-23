'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useCan } from '@/components/auth';
import { InvoiceStatusBadge, PaymentStatusBadge } from '@/components/finance/badges';
import { Button, Card, Dialog, Empty, ErrorText, Field, Input, Textarea } from '@/components/ui';
import { api, downloadFile } from '@/lib/api';
import { date, dateTime, money2 } from '@/lib/format';
import type { InvoiceDetail, PaymentRow } from '@/lib/types';

const remaining = (p: PaymentRow) =>
  ((Math.round(Number(p.amount) * 100) - Math.round(Number(p.refundedAmount) * 100)) / 100).toFixed(
    2,
  );

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const key = ['invoice', id];
  const qc = useQueryClient();
  const canVoid = useCan('invoices:edit');
  const canRefund = useCan('payments:approve');
  const invoice = useQuery({ queryKey: key, queryFn: () => api<InvoiceDetail>(`/invoices/${id}`) });
  const [voiding, setVoiding] = useState(false);
  const [refunding, setRefunding] = useState<PaymentRow | null>(null);
  const [pdfError, setPdfError] = useState<unknown>(null);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: key }),
      qc.invalidateQueries({ queryKey: ['invoices'] }),
    ]);

  if (invoice.error) return <ErrorText error={invoice.error} />;
  if (!invoice.data) return <p className="text-sm text-muted">Loading…</p>;
  const inv = invoice.data;
  const voidable =
    ['draft', 'issued', 'overdue'].includes(inv.status) &&
    !inv.payments.some((p) => p.status === 'succeeded');

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/console/finance/invoices" className="text-brand-700 hover:underline">
          ← Invoices
        </Link>
      </nav>
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold text-ink">
            {inv.number} <InvoiceStatusBadge status={inv.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {inv.organization ? (
              <Link
                href={`/console/crm/accounts/${inv.organization.id}`}
                className="text-brand-700 hover:underline"
              >
                {inv.organization.name}
              </Link>
            ) : (
              '—'
            )}{' '}
            · {inv.kind === 'one_off' ? 'One-off' : 'Subscription'}
            {inv.periodStart && ` · period ${date(inv.periodStart)} – ${date(inv.periodEnd)}`}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setPdfError(null);
              downloadFile(`/invoices/${inv.id}/pdf`, `${inv.number}.pdf`).catch(setPdfError);
            }}
          >
            Download PDF
          </Button>
          {canVoid && voidable && (
            <Button variant="danger" onClick={() => setVoiding(true)}>
              Void
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={pdfError} />

      <div className="grid gap-4 sm:grid-cols-4">
        {(
          [
            ['Issued', date(inv.issuedAt)],
            ['Due', date(inv.dueAt)],
            ['Paid', date(inv.paidAt)],
            ['Reminders sent', String(inv.remindersSent)],
          ] as const
        ).map(([label, value]) => (
          <Card key={label} className="p-4">
            <p className="text-xs text-muted">{label}</p>
            <p className="mt-1 font-medium text-ink">{value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Description
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Unit price
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {inv.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-2">{l.description}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(l.quantity)}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {/* overage prices can have 4 decimals */}
                  {Number(l.unitPrice).toLocaleString('en-US', {
                    style: 'currency',
                    currency: inv.currency,
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 4,
                  })}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {money2(l.amount, inv.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-right tabular-nums">
            <tr className="border-t border-line">
              <td colSpan={3} className="px-4 pt-3 text-muted">
                Subtotal
              </td>
              <td className="px-4 pt-3">{money2(inv.subtotal, inv.currency)}</td>
            </tr>
            <tr>
              <td colSpan={3} className="px-4 py-1 text-muted">
                {inv.taxLabel ?? 'Tax'}
                {inv.taxRatePercent && ` (${Number(inv.taxRatePercent)}%)`}
              </td>
              <td className="px-4 py-1">{money2(inv.tax, inv.currency)}</td>
            </tr>
            <tr className="font-semibold text-ink">
              <td colSpan={3} className="px-4 pb-3">
                Total {inv.currency}
              </td>
              <td className="px-4 pb-3">{money2(inv.total, inv.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
      {inv.notes && <p className="text-sm text-body">Notes: {inv.notes}</p>}

      <Card>
        <h2 className="text-base font-semibold text-ink">Payments</h2>
        {inv.payments.length === 0 && <Empty>No payments recorded.</Empty>}
        <ul className="mt-3 divide-y divide-line text-sm">
          {inv.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <PaymentStatusBadge status={p.status} />
              <span className="tabular-nums">{money2(p.amount, p.currency)}</span>
              <span className="text-muted">
                {p.gateway} · {p.gatewayRef} · {dateTime(p.createdAt)}
              </span>
              {Number(p.refundedAmount) > 0 && (
                <span className="text-amber-900">
                  refunded {money2(p.refundedAmount, p.currency)}
                </span>
              )}
              {p.receiptUrl && (
                <a
                  href={p.receiptUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand-700 hover:underline"
                >
                  Receipt
                </a>
              )}
              {canRefund && p.status === 'succeeded' && Number(remaining(p)) > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setRefunding(p)}
                >
                  Refund
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {voiding && (
        <VoidDialog invoiceId={inv.id} onClose={() => setVoiding(false)} onDone={refresh} />
      )}
      {refunding && (
        <RefundDialog payment={refunding} onClose={() => setRefunding(null)} onDone={refresh} />
      )}
    </div>
  );
}

function VoidDialog({
  invoiceId,
  onClose,
  onDone,
}: {
  invoiceId: string;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api(`/invoices/${invoiceId}/void`, { method: 'POST', body: { reason: reason.trim() } }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Void invoice">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <p className="text-sm text-body">
          A void invoice can no longer be paid. Its number stays used, so the sequence has no gaps.
        </p>
        <Field label="Reason" htmlFor="void-reason">
          <Textarea
            id="void-reason"
            required
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorText error={mutation.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={mutation.isPending || !reason.trim()}>
            Void invoice
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RefundDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: PaymentRow;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const max = remaining(payment);
  const [amount, setAmount] = useState(max);
  const [reason, setReason] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api(`/payments/${payment.id}/refund`, {
        method: 'POST',
        body: { amount: amount.trim(), reason: reason.trim() },
      }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title="Refund payment">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
      >
        <p className="text-sm text-body">
          Up to {money2(max, payment.currency)} can be refunded through {payment.gateway}.
        </p>
        <Field label={`Amount (${payment.currency})`} htmlFor="refund-amount">
          <Input
            id="refund-amount"
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="Reason" htmlFor="refund-reason">
          <Textarea
            id="refund-reason"
            required
            rows={2}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <ErrorText error={mutation.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending || !reason.trim()}>
            Refund
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
