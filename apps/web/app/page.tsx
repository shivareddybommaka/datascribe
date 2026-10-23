import Link from 'next/link';

// M0 placeholder. Real marketing pages are CMS-driven in M3.
export default function HomePage() {
  return (
    <main>
      <section className="bg-brand-gradient text-white">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <h1 className="text-4xl font-semibold tracking-tight">
            Medical record review for law firms
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-brand-50">
            Medical indexes, chronologies and summaries for personal injury, med-mal and workers
            comp.
          </p>
          <nav className="mt-10 flex gap-4">
            <Link
              className="rounded bg-white px-5 py-2.5 font-medium text-brand-700 hover:bg-brand-50"
              href="/portal"
            >
              Client portal
            </Link>
            <Link
              className="rounded border border-white/70 px-5 py-2.5 font-medium text-white hover:bg-white/10"
              href="/console"
            >
              Staff console
            </Link>
          </nav>
        </div>
      </section>
    </main>
  );
}
