import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@datascribe/shared', '@datascribe/ui'],
  poweredByHeader: false,
};

export default nextConfig;
