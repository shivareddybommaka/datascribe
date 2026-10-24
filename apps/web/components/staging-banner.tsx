import { STAGING_BANNER_TEXT } from '@/lib/deploy';

/**
 * Fixed, unmissable notice on every staging page (D-123). It sits above everything else (z-index)
 * and can't be dismissed; an invisible copy in the flow keeps it from covering the top of the
 * page at any width (same text, so the same height when it wraps).
 */
const box =
  'flex min-h-10 items-center justify-center border-b-2 px-4 py-2 text-center text-sm font-semibold';

export function StagingBanner() {
  return (
    <>
      <div
        role="region"
        aria-label="Staging notice"
        data-testid="staging-banner"
        className={`${box} fixed inset-x-0 top-0 z-[1000] border-red-900 bg-red-700 text-white shadow-md`}
      >
        {STAGING_BANNER_TEXT}
      </div>
      <div aria-hidden="true" className={`${box} invisible`}>
        {STAGING_BANNER_TEXT}
      </div>
    </>
  );
}
