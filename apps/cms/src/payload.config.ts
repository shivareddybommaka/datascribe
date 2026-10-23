import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';
import sharp from 'sharp';
import { Media } from './collections/Media';
import { Pages } from './collections/Pages';
import { Posts } from './collections/Posts';
import { Users } from './collections/Users';
import { loadRootEnv } from './env';
import { Site } from './globals/Site';

loadRootEnv();

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appUrl = process.env.APP_URL || 'http://localhost:3010';

export default buildConfig({
  serverURL: process.env.CMS_URL || `http://localhost:${process.env.CMS_PORT || 3001}`,
  admin: {
    user: Users.slug,
    importMap: { baseDir: path.resolve(dirname) },
    meta: { titleSuffix: ' · Datascribe CMS' },
  },
  collections: [Pages, Posts, Media, Users],
  globals: [Site],
  editor: lexicalEditor(),
  // `next build` needs no secret; every runtime path (server, CLI, seed) requires one.
  secret: process.env.PAYLOAD_SECRET || '',
  // Separate database from the platform (D-030): CMS editors and content never mix with PHI.
  db: postgresAdapter({
    pool: { connectionString: process.env.CMS_DATABASE_URL || '' },
    push: false,
    migrationDir: path.resolve(dirname, 'migrations'),
  }),
  // The marketing site reads content server-side; browsers only need the admin on this origin.
  cors: [appUrl],
  csrf: [appUrl],
  graphQL: { disable: true },
  telemetry: false,
  sharp,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
});
