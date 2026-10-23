'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useCan } from '@/components/auth';
import { InvoiceStatusBadge, PaymentStatusBadge } from '@/components/finance/badges';
import { Button, Card, Empty, ErrorText } from '@/components/ui';
import { api, downloadFile } from '@/lib/api';
import { date, dateTime, money2 } from '@/lib/format';
import type { InvoiceDetail } from '@/lib/types';

export default function PortalInvoicePage() {
  return (
    <Suspense>
      <Invoice />
    </Suspense>
  );
}

/** §5.3 invoice detail, receipts and pay by card (Stripe Checkout; Fake gateway in dev, D-042). */
function Invoice() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const canPay = useCan('payments:create');
  const invoice = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api<InvoiceDetail>(`/invoices/${id}`),
    // after checkout the webhook marks it paid moments later
    refetchInterval: (q) =>
      params.get('paid') && q.state.data && q.state.data.status !== 'paid' ? 2000 : false,
  });
  const [pdfError, setPdfError] = useState<unknown>(null);
  const pay = useMutation({
    mutationFn: () => api<{ url: string }>(`/invoices/${id}/pay`, { method: 'POST', body: {} }),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  if (invoice.error) return <ErrorText error={invoice.error} />;
  if (!invoice.data) return <p className="text-sm text-muted">Loading…</p>;
  const inv = invoice.data;
  const payable = ['issued', 'overdue'].includes(inv.status) && Number(inv.total) > 0;

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/portal/billing" className="text-brand-700 hover:underline">
          ← Billing
        </Link>
      </nav>
      {params.get('paid') && inv.status !== 'paid' && (
        <p role="status" className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-800">
          Payment received by the card processor; confirming…
        </p>
      )}
      {params.get('canceled') && (
        <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Checkout was cancelled. Nothing was charged.
        </p>
      )}
      <div className="flex flex-wrap items-start gap-4">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-semibold text-ink">
            {inv.number} <InvoiceStatusBadge status={inv.status} />
          </h1>
          <p className="mt-1 text-sm text-muted">
            Issued {date(inv.issuedAt)} · due {date(inv.dueAt)}
            {inv.paidAt && ` · paid ${date(inv.paidAt)}`}
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
          {canPay && payable && (
            <Button disabled={pay.isPending} onClick={() => pay.mutate()}>
              Pay {money2(inv.total, inv.currency)} by card
            </Button>
          )}
        </div>
      </div>
      <ErrorText error={pdfError ?? pay.error} />

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
                  {money2(l.amount, inv.currency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="text-right tabular-nums">
            <tr className="border-t border-line">
              <td colSpan={2} className="px-4 pt-3 text-muted">
                Subtotal
              </td>
              <td className="px-4 pt-3">{money2(inv.subtotal, inv.currency)}</td>
            </tr>
            <tr>
              <td colSpan={2} className="px-4 py-1 text-muted">
                {inv.taxLabel ?? 'Tax'}
                {inv.taxRatePercent && ` (${Number(inv.taxRatePercent)}%)`}
              </td>
              <td className="px-4 py-1">{money2(inv.tax, inv.currency)}</td>
            </tr>
            <tr className="font-semibold text-ink">
              <td colSpan={2} className="px-4 pb-3">
                Total {inv.currency}
              </td>
              <td className="px-4 pb-3">{money2(inv.total, inv.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-ink">Payments and receipts</h2>
        {inv.payments.length === 0 && <Empty>No payments yet.</Empty>}
        <ul className="mt-3 divide-y divide-line text-sm">
          {inv.payments.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
              <PaymentStatusBadge status={p.status} />
              <span className="tabular-nums">{money2(p.amount, p.currency)}</span>
              <span className="text-muted">{dateTime(p.createdAt)}</span>
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
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
