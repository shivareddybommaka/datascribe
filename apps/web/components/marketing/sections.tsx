import type { Block, Page } from '@datascribe/site-content';
import type { ReactNode } from 'react';
import { CtaLink } from './cta-link';
import { RichText } from './rich-text';

export function Hero({ hero, compact }: { hero: Page['hero']; compact?: boolean }) {
  return (
    <section aria-labelledby="page-title" className="bg-brand-gradient text-white">
      <div
        className={`mx-auto max-w-6xl px-4 sm:px-6 ${compact ? 'py-14 sm:py-16' : 'py-16 sm:py-24'}`}
      >
        {hero.eyebrow && (
          <p className="text-sm font-semibold tracking-wide text-brand-50 uppercase">
            {hero.eyebrow}
          </p>
        )}
        <h1
          id="page-title"
          className="mt-2 max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl"
        >
          {hero.heading}
        </h1>
        {hero.subheading && (
          <p className="mt-4 max-w-2xl text-lg leading-8 text-brand-50">{hero.subheading}</p>
        )}
        {!!hero.ctas?.length && (
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {hero.ctas.map((cta) => (
              <CtaLink key={`${cta.href}-${cta.label}`} cta={cta} onDark />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SectionShell({
  id,
  heading,
  intro,
  tone = 'white',
  children,
}: {
  id: string;
  heading?: string | null;
  intro?: string | null;
  tone?: 'white' | 'surface';
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={heading ? id : undefined}
      className={tone === 'surface' ? 'bg-surface' : 'bg-white'}
    >
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        {heading && (
          <h2 id={id} className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {heading}
          </h2>
        )}
        {intro && <p className="mt-3 max-w-2xl text-lg text-body">{intro}</p>}
        {children}
      </div>
    </section>
  );
}

function renderBlock(block: Block, i: number) {
  const id = `section-${i}`;
  const tone = i % 2 === 0 ? 'white' : 'surface';
  switch (block.blockType) {
    case 'features':
      return (
        <SectionShell key={id} id={id} heading={block.heading} intro={block.intro} tone={tone}>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {block.items.map((item) => (
              <li key={item.title} className="rounded-lg border border-line bg-white p-6">
                <h3 className="text-lg font-semibold text-ink">{item.title}</h3>
                <p className="mt-2 leading-7 text-body">{item.body}</p>
              </li>
            ))}
          </ul>
        </SectionShell>
      );
    case 'steps':
      return (
        <SectionShell key={id} id={id} heading={block.heading} intro={block.intro} tone={tone}>
          <ol className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {block.items.map((item, n) => (
              <li key={item.title} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 font-semibold text-white"
                >
                  {n + 1}
                </span>
                <div>
                  <h3 className="text-lg font-semibold text-ink">{item.title}</h3>
                  <p className="mt-1 leading-7 text-body">{item.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </SectionShell>
      );
    case 'content':
      return (
        <SectionShell key={id} id={id} heading={block.heading} tone={tone}>
          <RichText value={block.body} className="prose-ds mt-6 max-w-3xl" />
        </SectionShell>
      );
    case 'faq':
      return (
        <SectionShell key={id} id={id} heading={block.heading} tone={tone}>
          <dl className="mt-8 max-w-3xl divide-y divide-line">
            {block.items.map((item) => (
              <div key={item.question} className="py-5">
                <dt className="text-lg font-semibold text-ink">{item.question}</dt>
                <dd className="mt-2 leading-7 text-body">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </SectionShell>
      );
    case 'cta':
      return (
        <section key={id} aria-labelledby={id} className="bg-navy-800 text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-14 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 id={id} className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {block.heading}
              </h2>
              {block.body && <p className="mt-2 text-lg text-navy-50">{block.body}</p>}
            </div>
            <CtaLink cta={{ ...block.cta, variant: 'primary' }} onDark />
          </div>
        </section>
      );
    default:
      return null; // block type added in the CMS before the site knows how to render it
  }
}

export function Sections({ sections }: { sections: Page['sections'] }) {
  return <>{(sections ?? []).map(renderBlock)}</>;
}
