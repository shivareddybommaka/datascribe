import type { Cta } from '@datascribe/site-content';
import Link from 'next/link';
import { cn } from '@/lib/cn';

const styles = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'border border-brand-600 bg-white text-brand-700 hover:bg-brand-50',
  // on the gradient hero band
  onDarkPrimary: 'bg-white text-brand-700 hover:bg-brand-50',
  onDarkSecondary: 'border border-white/80 text-white hover:bg-white/10',
};

/** CMS call-to-action link. Hrefs are validated by the CMS (site paths or https URLs). */
export function CtaLink({
  cta,
  onDark,
  className,
  ariaLabel,
}: {
  cta: Cta;
  onDark?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const variant = cta.variant === 'secondary' ? 'Secondary' : 'Primary';
  const style = onDark
    ? styles[`onDark${variant}`]
    : styles[variant === 'Primary' ? 'primary' : 'secondary'];
  return (
    <Link
      href={cta.href}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex min-h-11 items-center justify-center rounded-md px-5 py-2.5 text-base font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2',
        onDark ? 'focus-visible:outline-white' : 'focus-visible:outline-brand-600',
        style,
        className,
      )}
    >
      {cta.label}
    </Link>
  );
}
