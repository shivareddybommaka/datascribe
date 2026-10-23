import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPayload } from '@payloadcms/next/withPayload';
import type { NextConfig } from 'next';
import { loadRootEnv } from './src/env';

loadRootEnv();

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@datascribe/site-content'],
  images: { localPatterns: [{ pathname: '/api/media/file/**' }] },
  async redirects() {
    return [{ source: '/', destination: '/admin', permanent: false }];
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return webpackConfig;
  },
  turbopack: { root: path.resolve(dirname, '../..') },
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
