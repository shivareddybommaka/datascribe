/**
 * Seeds the CMS with synthetic placeholder copy (packages/site-content defaults): the 7 marketing
 * pages, 3 blog posts and the site settings. Idempotent: existing pages/posts (matched by slug) are
 * left alone unless --force is given, so editors' changes survive a re-run.
 *
 *   pnpm --filter @datascribe/cms seed            # create what's missing
 *   pnpm --filter @datascribe/cms seed -- --force # overwrite with the defaults
 */
import { DEFAULT_PAGES, DEFAULT_POSTS, DEFAULT_SITE, PAGE_SLUGS } from '@datascribe/site-content';
import config from '@payload-config';
import { getPayload } from 'payload';

const force = process.argv.includes('--force');
// The shared content types are looser than Payload's generated ones; publish the defaults as-is.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const published = (data: object): any => ({ ...data, _status: 'published' });
const payload = await getPayload({ config });

let created = 0;
let updated = 0;
let skipped = 0;

for (const slug of PAGE_SLUGS) {
  // seo.ogImage is left empty: there are no seeded images
  const { seo, ...rest } = DEFAULT_PAGES[slug];
  const data = { ...rest, seo: { title: seo?.title, description: seo?.description } };
  const existing = await payload.find({ collection: 'pages', where: { slug: { equals: slug } } });
  const doc = existing.docs[0];
  if (doc && !force) {
    skipped++;
  } else if (doc) {
    await payload.update({ collection: 'pages', id: doc.id, data: published(data) });
    updated++;
  } else {
    await payload.create({ collection: 'pages', data: published(data) });
    created++;
  }
}

for (const post of DEFAULT_POSTS) {
  const { seo, ...rest } = post;
  const data = { ...rest, seo: { title: seo?.title, description: seo?.description } };
  const existing = await payload.find({
    collection: 'posts',
    where: { slug: { equals: post.slug } },
  });
  const doc = existing.docs[0];
  if (doc && !force) {
    skipped++;
  } else if (doc) {
    await payload.update({ collection: 'posts', id: doc.id, data: published(data) });
    updated++;
  } else {
    await payload.create({ collection: 'posts', data: published(data) });
    created++;
  }
}

const site = await payload.findGlobal({ slug: 'site' });
if (force || !site.nav?.length) {
  await payload.updateGlobal({ slug: 'site', data: DEFAULT_SITE });
  updated++;
} else {
  skipped++;
}

console.log(`CMS seed done: ${created} created, ${updated} updated, ${skipped} unchanged.`);
const admins = await payload.count({ collection: 'users' });
if (admins.totalDocs === 0) {
  console.log(`No CMS admin yet: open ${payload.config.serverURL}/admin to create the first one.`);
}
process.exit(0);
