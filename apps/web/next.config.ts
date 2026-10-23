import type { NextConfig } from 'next';

const apiUrl = process.env.API_URL ?? 'http://localhost:4000';

const nextConfig: NextConfig = {
  transpilePackages: ['@datascribe/shared', '@datascribe/ui'],
  poweredByHeader: false,
  // Same-origin API: the refresh cookie (Path=/api/v1/auth, SameSite=Strict) and the CSRF Origin
  // check both rely on the browser talking to the web origin.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
