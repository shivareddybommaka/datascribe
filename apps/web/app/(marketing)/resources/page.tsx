import Link from 'next/link';
import { MarketingPage, pageMetadata } from '@/components/marketing/marketing-page';
import { getPosts, postDate } from '@/lib/cms';

export const revalidate = 60;
export const generateMetadata = () => pageMetadata('resources');

export default async function ResourcesPage() {
  const posts = await getPosts();
  return (
    <MarketingPage slug="resources">
      <section aria-labelledby="articles-heading" className="bg-white">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
          <h2 id="articles-heading" className="sr-only">
            Articles
          </h2>
          {posts.length === 0 ? (
            <p className="text-body">New articles are on the way.</p>
          ) : (
            <ul className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {posts.map((post) => (
                <li key={post.slug}>
                  <article className="flex h-full flex-col rounded-lg border border-line p-6">
                    <h3 className="text-lg font-semibold text-ink">
                      <Link
                        href={`/resources/${post.slug}`}
                        className="hover:text-brand-700 hover:underline"
                      >
                        {post.title}
                      </Link>
                    </h3>
                    <p className="mt-1 text-sm text-muted">
                      <time dateTime={post.publishedAt}>{postDate(post.publishedAt)}</time>
                      {post.author ? ` · ${post.author}` : ''}
                    </p>
                    <p className="mt-3 flex-1 leading-7 text-body">{post.excerpt}</p>
                  </article>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </MarketingPage>
  );
}
