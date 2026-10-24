/** Staging guard rails (D-123): banner, noindex, no analytics. */
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RootLayout, { metadata } from '../app/layout';
import robots from '../app/robots';
import { StagingBanner } from '../components/staging-banner';
import { analyticsIds } from '../lib/analytics';
import { STAGING_BANNER_TEXT, STAGING_HEADERS, isStaging } from '../lib/deploy';

const ids = { GA4_MEASUREMENT_ID: 'G-ABC123', GTM_ID: 'GTM-XYZ9' };
const staging = { NODE_ENV: 'production', DEPLOY_ENV: 'staging' };

type El = ReactElement<{ children?: unknown }>;
const kids = (el: El): unknown[] => [el.props.children].flat();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('staging guard rails (D-123)', () => {
  it('detects staging from DEPLOY_ENV only', () => {
    expect(isStaging(staging)).toBe(true);
    expect(isStaging({ NODE_ENV: 'production' })).toBe(false);
    expect(isStaging({ NODE_ENV: 'development' })).toBe(false);
  });

  it('never loads GA4/GTM in staging', () => {
    expect(analyticsIds({ ...ids, ...staging })).toEqual({});
    expect(analyticsIds({ ...ids, NODE_ENV: 'production' })).toEqual({
      ga4Id: 'G-ABC123',
      gtmId: 'GTM-XYZ9',
    });
  });

  it('robots.txt disallows everything in staging and keeps the normal rules otherwise', () => {
    vi.stubEnv('DEPLOY_ENV', 'staging');
    expect(robots()).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
    vi.stubEnv('DEPLOY_ENV', '');
    const normal = robots();
    expect(normal.rules).toEqual([
      { userAgent: '*', allow: '/', disallow: ['/console', '/portal', '/invite', '/api/'] },
    ]);
    expect(normal.sitemap).toMatch(/sitemap\.xml$/);
  });

  it('sends X-Robots-Tag: noindex on every path of a staging build only', async () => {
    vi.stubEnv('ENV_FILE', '/nonexistent/.env');
    vi.stubEnv('DEPLOY_ENV', 'staging');
    const stagingConfig = (await import('../next.config')).default;
    const [rule] = await stagingConfig.headers!();
    expect(rule!.source).toBe('/:path*');
    expect(rule!.headers).toEqual(expect.arrayContaining(STAGING_HEADERS));
    expect(rule!.headers).toEqual(
      expect.arrayContaining([{ key: 'X-Frame-Options', value: 'DENY' }]),
    );

    vi.resetModules();
    vi.stubEnv('DEPLOY_ENV', '');
    const prodConfig = (await import('../next.config')).default;
    const [prodRule] = await prodConfig.headers!();
    expect(prodRule!.headers.some((h) => h.key === 'X-Robots-Tag')).toBe(false);
  });

  it('renders the fixed banner on every page of a staging build, and noindex metadata', async () => {
    vi.stubEnv('DEPLOY_ENV', 'staging');
    vi.resetModules();
    const mod = await import('../app/layout');
    const body = kids(mod.default({ children: 'page' }) as El)[0] as El;
    // a fresh module copy after resetModules: compare by name
    expect(((kids(body)[0] as El).type as { name: string }).name).toBe('StagingBanner');
    expect(mod.metadata.robots).toEqual({ index: false, follow: false });

    const banner = StagingBanner() as El;
    const [fixed] = kids(banner) as El[];
    expect(kids(fixed!)).toEqual([STAGING_BANNER_TEXT]);
    expect(String((fixed!.props as { className?: string }).className)).toMatch(/\bfixed\b/);
    expect(STAGING_BANNER_TEXT).toBe(
      'Staging — synthetic data only. Do not upload real patient records.',
    );
  });

  it('no banner and normal metadata outside staging', () => {
    const body = kids(RootLayout({ children: 'page' }) as El)[0] as El;
    expect(kids(body)[0]).toBeNull();
    expect(metadata.robots).toBeUndefined();
  });
});
