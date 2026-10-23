import Link from 'next/link';

// M0 placeholder. Real marketing pages are CMS-driven in M3.
export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-4xl font-semibold tracking-tight">Datascribe</h1>
      <p className="mt-4 text-lg text-brand-700">
        Medical record review, chronologies and summaries for law firms.
      </p>
      <nav className="mt-10 flex gap-4">
        <Link
          className="rounded bg-brand-600 px-4 py-2 text-white hover:bg-brand-700"
          href="/portal"
        >
          Client portal
        </Link>
        <Link
          className="rounded border border-brand-500 px-4 py-2 hover:bg-brand-50"
          href="/console"
        >
          Staff console
        </Link>
      </nav>
    </main>
  );
}
