import type { Block } from 'payload';
import { ctaGroup } from './fields';

const items = (label: string) => ({
  name: 'items',
  type: 'array' as const,
  labels: { singular: label, plural: `${label}s` },
  minRows: 1,
  fields: [
    { name: 'title', type: 'text' as const, required: true },
    { name: 'body', type: 'textarea' as const, required: true },
  ],
});

/** Page section blocks. Their slugs are the `blockType` values apps/web renders. */
export const sectionBlocks: Block[] = [
  {
    slug: 'features',
    labels: { singular: 'Feature grid', plural: 'Feature grids' },
    fields: [
      { name: 'heading', type: 'text', required: true },
      { name: 'intro', type: 'textarea' },
      items('Feature'),
    ],
  },
  {
    slug: 'steps',
    labels: { singular: 'Numbered steps', plural: 'Numbered steps' },
    fields: [
      { name: 'heading', type: 'text', required: true },
      { name: 'intro', type: 'textarea' },
      items('Step'),
    ],
  },
  {
    slug: 'content',
    labels: { singular: 'Rich text', plural: 'Rich text' },
    fields: [
      { name: 'heading', type: 'text' },
      { name: 'body', type: 'richText', required: true },
    ],
  },
  {
    slug: 'faq',
    labels: { singular: 'FAQ', plural: 'FAQs' },
    fields: [
      { name: 'heading', type: 'text', required: true },
      {
        name: 'items',
        type: 'array',
        minRows: 1,
        labels: { singular: 'Question', plural: 'Questions' },
        fields: [
          { name: 'question', type: 'text', required: true },
          { name: 'answer', type: 'textarea', required: true },
        ],
      },
    ],
  },
  {
    slug: 'cta',
    labels: { singular: 'Call to action', plural: 'Calls to action' },
    fields: [
      { name: 'heading', type: 'text', required: true },
      { name: 'body', type: 'textarea' },
      ctaGroup('cta', 'Button'),
    ],
  },
];
