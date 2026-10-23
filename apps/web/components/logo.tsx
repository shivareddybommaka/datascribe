import Image from 'next/image';
import Link from 'next/link';

/** Datascribe Technologies wordmark (438×108 PNG from datascribetech.com). */
export function Logo({ height = 40, href = '/' }: { height?: number; href?: string }) {
  const width = Math.round((438 / 108) * height);
  return (
    <Link href={href} aria-label="Datascribe home" className="inline-flex items-center">
      <Image
        src="/brand/datascribe-logo.png"
        alt="Datascribe Technologies"
        width={width}
        height={height}
        priority
      />
    </Link>
  );
}
