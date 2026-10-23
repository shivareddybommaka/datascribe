import fs from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// One .env at the monorepo root (Next only reads apps/web/.env*). Variables already set win.
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@datascribe/shared', '@datascribe/ui', '@datascribe/site-content'],
  poweredByHeader: false,
  // Same-origin API: the refresh cookie (Path=/api/v1/auth, SameSite=Strict) and the CSRF Origin
  // check both rely on the browser talking to the web origin.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
