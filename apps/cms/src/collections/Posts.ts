import type { CollectionConfig } from 'payload';
import { publishedOrSignedIn, signedIn } from '../access';
import { seoGroup, slugField } from '../fields';

/** Blog posts for Resources (/resources and /resources/<slug>). */
export const Posts: CollectionConfig = {
  slug: 'posts',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'publishedAt', '_status'],
  },
  access: {
    read: publishedOrSignedIn,
    create: signedIn,
    update: signedIn,
    delete: signedIn,
  },
  versions: { drafts: true, maxPerDoc: 25 },
  defaultSort: '-publishedAt',
  fields: [
    { name: 'title', type: 'text', required: true },
    slugField('title'),
    { name: 'excerpt', type: 'textarea', required: true, maxLength: 300 },
    { name: 'author', type: 'text' },
    {
      name: 'publishedAt',
      type: 'date',
      required: true,
      defaultValue: () => new Date().toISOString(),
      admin: { position: 'sidebar' },
    },
    { name: 'coverImage', type: 'upload', relationTo: 'media' },
    { name: 'body', type: 'richText', required: true },
    seoGroup,
  ],
};
