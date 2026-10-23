import type { LeadStage } from '@datascribe/shared/constants';

export const STAGE_LABEL: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  qualified: 'Qualified',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
};

export const SOURCE_LABEL: Record<string, string> = {
  website_contact: 'Website contact',
  website_demo: 'Website demo',
  manual: 'Manual',
  import: 'Import',
  referral: 'Referral',
  event: 'Event',
  other: 'Other',
};

export function money(value: string | number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** <input type="date"> value → ISO at local midnight, or null. */
export const dateInputToIso = (v: string) => (v ? new Date(`${v}T00:00:00`).toISOString() : null);
export const isoToDateInput = (v: string | null) => (v ? v.slice(0, 10) : '');

/** End of the user's local day, sent to /activities/my-tasks. */
export function endOfLocalDay(): string {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}
