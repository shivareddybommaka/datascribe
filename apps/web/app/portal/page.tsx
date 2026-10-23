import { SiteHeader } from '@/components/site-header';

export default function PortalPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-6 py-24">
        <h1 className="text-2xl font-semibold text-ink">Client portal</h1>
        <p className="mt-2 text-muted">Cases and uploads arrive in M4.</p>
      </main>
    </>
  );
}
