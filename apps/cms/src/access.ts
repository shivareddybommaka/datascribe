import type { Access } from 'payload';

/** CMS users are all editors/admins (separate from platform users), so "signed in" is the gate. */
export const signedIn: Access = ({ req }) => Boolean(req.user);

/** The public site (anonymous REST reads) sees published documents only; editors see drafts too. */
export const publishedOrSignedIn: Access = ({ req }) =>
  req.user ? true : { _status: { equals: 'published' } };

export const anyone: Access = () => true;
