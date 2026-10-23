import type { CollectionConfig } from 'payload';
import { anyone, signedIn } from '../access';

/** Images for pages, posts and Open Graph. Stored on local disk in dev (apps/cms/media, git-ignored). */
export const Media: CollectionConfig = {
  slug: 'media',
  access: { read: anyone, create: signedIn, update: signedIn, delete: signedIn },
  upload: {
    staticDir: 'media',
    mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    imageSizes: [{ name: 'og', width: 1200, height: 630, position: 'centre' }],
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
      admin: { description: 'Describe the image for screen readers.' },
    },
  ],
};
