import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// One .env at the monorepo root (Next only reads apps/web/.env*). Variables already set win.
// ENV_FILE picks another file, e.g. staging's .env.staging, so dev's .env never leaks in (D-123).
const rootEnv = path.resolve(process.cwd(), process.env.ENV_FILE || '../../.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Staging pages, assets and API responses are never indexed (D-123); read at build time. Same
 * header as lib/deploy.ts (kept inline: the config can't import workspace TypeScript).
 */
const stagingHeaders = () =>
  process.env.DEPLOY_ENV?.trim() === 'staging'
    ? [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }]
    : [];

const nextConfig: NextConfig = {
  // `next dev` writes to .next-dev so a running preview never collides with `next build` (.next).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['@datascribe/shared', '@datascribe/ui', '@datascribe/site-content'],
  poweredByHeader: false,
  // Baseline security headers (audit finding M8). A full script CSP comes with M10 hardening.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...stagingHeaders(),
        ],
      },
    ];
  },
  // Same-origin API: the refresh cookie (Path=/api/v1/auth, SameSite=Strict) and the CSRF Origin
  // check both rely on the browser talking to the web origin.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
