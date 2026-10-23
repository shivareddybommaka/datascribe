'use client';

import { Badge, cn } from '@/components/ui';
import type { InvoiceStatus, PaymentRow, SubscriptionRow, Usage } from '@/lib/types';

const INVOICE_TONE = {
  draft: 'neutral',
  issued: 'brand',
  paid: 'green',
  void: 'neutral',
  overdue: 'red',
  refunded: 'amber',
} as const satisfies Record<InvoiceStatus, string>;

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={INVOICE_TONE[status]}>{status}</Badge>;
}

const SUB_TONE = {
  trialing: 'brand',
  active: 'green',
  past_due: 'red',
  canceled: 'neutral',
} as const satisfies Record<SubscriptionRow['status'], string>;

export function SubscriptionStatusBadge({ sub }: { sub: SubscriptionRow }) {
  return (
    <span className="inline-flex gap-1">
      <Badge tone={SUB_TONE[sub.status]}>{sub.status.replace('_', ' ')}</Badge>
      {sub.cancelAtPeriodEnd && sub.status !== 'canceled' && <Badge tone="amber">ends</Badge>}
    </span>
  );
}

const PAYMENT_TONE = {
  pending: 'neutral',
  succeeded: 'green',
  failed: 'red',
  refunded: 'amber',
} as const satisfies Record<PaymentRow['status'], string>;

export function PaymentStatusBadge({ status }: { status: PaymentRow['status'] }) {
  return <Badge tone={PAYMENT_TONE[status]}>{status}</Badge>;
}

/** Pages used this period vs the plan's included pages (§5.3 usage meter). */
export function UsageMeter({ usage }: { usage: Usage | null | undefined }) {
  if (!usage) return <span className="text-muted">—</span>;
  const pct = usage.percentUsed ?? 0;
  return (
    <div className="min-w-40">
      <div
        role="meter"
        aria-label="Pages used this period"
        aria-valuemin={0}
        aria-valuemax={usage.includedPages}
        aria-valuenow={usage.pagesUsed}
        className="h-2 overflow-hidden rounded-full bg-gray-100"
      >
        <div
          className={cn(
            'h-full',
            pct > 100 ? 'bg-red-600' : pct >= 80 ? 'bg-amber-500' : 'bg-brand-600',
          )}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className="mt-1 text-xs tabular-nums text-muted">
        {usage.pagesUsed.toLocaleString()} / {usage.includedPages.toLocaleString()} pages
        {usage.overagePages > 0 && (
          <span className="text-red-700"> · {usage.overagePages.toLocaleString()} over</span>
        )}
      </p>
    </div>
  );
}
