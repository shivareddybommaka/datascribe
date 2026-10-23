import { PAGE_LABELS, PAGE_SLUGS, type PageSlug } from '@datascribe/site-content';
import type { CollectionConfig, Condition } from 'payload';
import { publishedOrSignedIn, signedIn } from '../access';
import { sectionBlocks } from '../blocks';
import { ctaFields, ctaGroup, seoGroup } from '../fields';

const onlyFor =
  (slug: PageSlug): Condition =>
  (data) =>
    (data as { slug?: string } | undefined)?.slug === slug;

/**
 * The 7 marketing pages (§5.1). One document per fixed slug; apps/web maps each slug to a route, so
 * editors change copy and sections but not URLs.
 */
export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', '_status', 'updatedAt'],
    description: 'Marketing pages. Each page has a fixed URL on the public site.',
  },
  access: {
    read: publishedOrSignedIn,
    create: signedIn,
    update: signedIn,
    delete: signedIn,
  },
  versions: { drafts: true, maxPerDoc: 25 },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'slug',
      type: 'select',
      required: true,
      unique: true,
      index: true,
      options: PAGE_SLUGS.map((value) => ({ value, label: PAGE_LABELS[value] })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'hero',
      type: 'group',
      fields: [
        { name: 'eyebrow', type: 'text' },
        { name: 'heading', type: 'text', required: true },
        { name: 'subheading', type: 'textarea' },
        {
          name: 'ctas',
          label: 'Buttons',
          type: 'array',
          maxRows: 3,
          fields: ctaFields(),
        },
      ],
    },
    {
      name: 'pricing',
      label: 'Pricing cards',
      type: 'group',
      admin: {
        condition: onlyFor('pricing'),
        description:
          'Copy around the plan cards. Plan names, prices, pages and features come from the billing plans (SubscriptionPlan), so they are never duplicated here.',
      },
      fields: [
        { name: 'heading', type: 'text' },
        { name: 'intro', type: 'textarea' },
        {
          name: 'highlightedPlan',
          type: 'text',
          admin: { description: 'Plan name to mark as "Most popular", e.g. Professional.' },
        },
        { name: 'includedPagesLabel', type: 'text', defaultValue: 'pages included each month' },
        { name: 'overageLabel', type: 'text', defaultValue: 'per extra page' },
        ctaGroup('cardCta', 'Card button'),
        { name: 'footnote', type: 'textarea' },
        {
          name: 'unavailableMessage',
          type: 'textarea',
          admin: { description: 'Shown if plans cannot be loaded.' },
        },
        {
          name: 'taglines',
          type: 'array',
          fields: [
            { name: 'planName', type: 'text', required: true },
            { name: 'tagline', type: 'text', required: true },
          ],
        },
      ],
    },
    {
      name: 'contactForm',
      label: 'Contact form copy',
      type: 'group',
      admin: {
        condition: onlyFor('contact'),
        description: 'Labels and messages for the contact / book-a-demo form.',
      },
      fields: [
        { name: 'kindLabel', type: 'text' },
        { name: 'demoOption', type: 'text' },
        { name: 'contactOption', type: 'text' },
        { name: 'nameLabel', type: 'text' },
        { name: 'companyLabel', type: 'text' },
        { name: 'emailLabel', type: 'text' },
        { name: 'phoneLabel', type: 'text' },
        { name: 'messageLabel', type: 'text' },
        { name: 'submitLabel', type: 'text' },
        { name: 'sendingLabel', type: 'text' },
        { name: 'successMessage', type: 'textarea' },
      ],
    },
    {
      name: 'sections',
      type: 'blocks',
      blocks: sectionBlocks,
    },
    seoGroup,
  ],
};
