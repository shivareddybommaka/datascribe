import type { CollectionConfig } from 'payload';
import { signedIn } from '../access';

/**
 * CMS editors. Separate from Datascribe platform users (packages/db User): different database, no
 * roles shared, no access to the portal, console or API. The first one is created at /admin.
 */
export const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email' },
  auth: {
    tokenExpiration: 60 * 60 * 8,
    maxLoginAttempts: 5,
    lockTime: 15 * 60 * 1000,
    cookies: { sameSite: 'Strict', secure: process.env.NODE_ENV === 'production' },
  },
  access: { read: signedIn, create: signedIn, update: signedIn, delete: signedIn },
  fields: [{ name: 'name', type: 'text' }],
};
