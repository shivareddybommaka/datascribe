import { plainText } from '@datascribe/site-content';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RichText } from '@/components/marketing/rich-text';
import { getPost, getPosts, mediaUrl, postDate } from '@/lib/cms';
import { seoMetadata } from '@/lib/seo';

export const revalidate = 60;
// New posts published in the CMS render on first request, then stay cached.
export const dynamicParams = true;

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return (await getPosts()).map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) return { title: 'Not found', robots: { index: false } };
  return seoMetadata(
    { ...post.seo, ogImage: post.seo?.ogImage ?? post.coverImage },
    {
      title: `${post.title} | Datascribe`,
      description: post.excerpt || plainText(post.body).slice(0, 160),
      path: `/resources/${post.slug}`,
      type: 'article',
    },
  );
}

export default async function PostPage({ params }: Props) {
  const { slug } = await params;
  const post = await getPost(slug);
  if (!post) notFound();
  const cover = mediaUrl(post.coverImage);
  const coverAlt =
    post.coverImage && typeof post.coverImage === 'object' ? (post.coverImage.alt ?? '') : '';

  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/resources" className="text-brand-700 hover:underline">
          ← All resources
        </Link>
      </nav>
      <header className="mt-6">
        <h1 id="page-title" className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          {post.title}
        </h1>
        <p className="mt-3 text-sm text-muted">
          <time dateTime={post.publishedAt}>{postDate(post.publishedAt)}</time>
          {post.author ? ` · ${post.author}` : ''}
        </p>
      </header>
      {cover && (
        // CMS-hosted image; plain <img> avoids configuring remote patterns per environment
        <img src={cover} alt={coverAlt} className="mt-8 w-full rounded-lg" loading="lazy" />
      )}
      <RichText value={post.body} className="prose-ds mt-8" />
    </article>
  );
}
