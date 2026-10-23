import type { Field, GroupField } from 'payload';

/** A link-style call to action. Hrefs are site-relative ("/pricing") or absolute https URLs. */
export function ctaFields(): Field[] {
  return [
    { name: 'label', type: 'text', required: true },
    {
      name: 'href',
      type: 'text',
      required: true,
      validate: (value: unknown) =>
        typeof value === 'string' && /^(\/(?!\/)|https:\/\/)/.test(value)
          ? true
          : 'Use a site path like /pricing or a full https:// URL',
    },
    {
      name: 'variant',
      type: 'select',
      defaultValue: 'primary',
      options: [
        { label: 'Primary', value: 'primary' },
        { label: 'Secondary', value: 'secondary' },
      ],
    },
  ];
}

export const ctaGroup = (name: string, label?: string): GroupField => ({
  name,
  label,
  type: 'group',
  fields: ctaFields(),
});

/** Per-page/post SEO (§5.1): title, description and Open Graph image. */
export const seoGroup: GroupField = {
  name: 'seo',
  label: 'SEO',
  type: 'group',
  fields: [
    {
      name: 'title',
      type: 'text',
      maxLength: 70,
      admin: { description: 'Browser tab and search result title. Falls back to the page title.' },
    },
    {
      name: 'description',
      type: 'textarea',
      maxLength: 160,
      admin: { description: 'Search result snippet, up to 160 characters.' },
    },
    {
      name: 'ogImage',
      label: 'Open Graph image',
      type: 'upload',
      relationTo: 'media',
      admin: { description: 'Shown when the page is shared. 1200×630 works best.' },
    },
  ],
};

export const slugField = (from: string): Field => ({
  name: 'slug',
  type: 'text',
  required: true,
  unique: true,
  index: true,
  admin: { position: 'sidebar', description: `URL segment, generated from the ${from} if empty.` },
  validate: (value: unknown) =>
    typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
      ? true
      : 'Lowercase letters, digits and single hyphens only',
  hooks: {
    beforeValidate: [
      ({ value, data }) => {
        if (typeof value === 'string' && value) return value;
        const source = (data as Record<string, unknown> | undefined)?.[from];
        return typeof source === 'string'
          ? source
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
          : value;
      },
    ],
  },
});
