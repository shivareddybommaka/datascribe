import type { GlobalConfig } from 'payload';
import { anyone, signedIn } from '../access';
import { ctaGroup } from '../fields';

/** Site-wide chrome: navigation, header button, footer and cookie banner copy. */
export const Site: GlobalConfig = {
  slug: 'site',
  label: 'Site settings',
  access: { read: anyone, update: signedIn },
  fields: [
    { name: 'siteName', type: 'text', required: true, defaultValue: 'Datascribe' },
    {
      name: 'nav',
      label: 'Navigation',
      type: 'array',
      maxRows: 8,
      fields: [
        { name: 'label', type: 'text', required: true },
        { name: 'href', type: 'text', required: true },
      ],
    },
    ctaGroup('headerCta', 'Header button'),
    {
      name: 'footer',
      type: 'group',
      fields: [
        { name: 'tagline', type: 'textarea' },
        { name: 'legal', type: 'text' },
      ],
    },
    {
      name: 'cookieBanner',
      type: 'group',
      admin: {
        description:
          'Analytics (GA4/GTM) only load after a visitor accepts. Declining or ignoring the banner keeps them off.',
      },
      fields: [
        { name: 'message', type: 'textarea' },
        { name: 'acceptLabel', type: 'text' },
        { name: 'declineLabel', type: 'text' },
      ],
    },
  ],
};
