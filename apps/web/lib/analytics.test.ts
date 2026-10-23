import { describe, expect, it } from 'vitest';
import {
  analyticsIds,
  analyticsScripts,
  isPrivatePath,
  readConsent,
  shouldLoadAnalytics,
} from './analytics';

const ids = { ga4Id: 'G-TEST1234', gtmId: 'GTM-TEST123' };

describe('analytics gating', () => {
  it('never loads on console, portal, invite or API paths, even with consent', () => {
    for (const p of [
      '/console',
      '/console/crm/leads',
      '/console/login',
      '/portal',
      '/portal/cases/1',
      '/invite/accept',
      '/api/v1/public/plans',
    ]) {
      expect(isPrivatePath(p)).toBe(true);
      expect(shouldLoadAnalytics(p, 'granted', ids)).toBe(false);
    }
  });

  it('loads on marketing paths only after consent is granted', () => {
    for (const p of ['/', '/pricing', '/resources/some-post', '/contact', '/consoles-guide']) {
      expect(isPrivatePath(p)).toBe(false);
      expect(shouldLoadAnalytics(p, 'granted', ids)).toBe(true);
      expect(shouldLoadAnalytics(p, 'denied', ids)).toBe(false);
      // no choice yet = declined (§5.1)
      expect(shouldLoadAnalytics(p, null, ids)).toBe(false);
    }
  });

  it('loads nothing when no IDs are configured', () => {
    expect(analyticsIds({ GA4_MEASUREMENT_ID: '', GTM_ID: '' })).toEqual({
      ga4Id: undefined,
      gtmId: undefined,
    });
    expect(shouldLoadAnalytics('/', 'granted', {})).toBe(false);
    expect(analyticsScripts({})).toEqual([]);
  });

  it('rejects malformed IDs so env values cannot inject script', () => {
    expect(
      analyticsIds({ GA4_MEASUREMENT_ID: "G-1');alert(1);//", GTM_ID: 'GTM-<script>' }),
    ).toEqual({ ga4Id: undefined, gtmId: undefined });
    expect(analyticsIds({ GA4_MEASUREMENT_ID: ' G-ABC123 ', GTM_ID: 'GTM-XYZ9' })).toEqual({
      ga4Id: 'G-ABC123',
      gtmId: 'GTM-XYZ9',
    });
  });

  it('reads the consent cookie', () => {
    expect(readConsent('a=1; ds_consent=granted; b=2')).toBe('granted');
    expect(readConsent('ds_consent=denied')).toBe('denied');
    expect(readConsent('ds_consent=maybe')).toBeNull();
    expect(readConsent('xds_consent=granted')).toBeNull();
    expect(readConsent(undefined)).toBeNull();
  });

  it('builds GTM and GA4 tags for the configured IDs', () => {
    const tags = analyticsScripts(ids);
    expect(tags.map((t) => t.id)).toEqual(['gtm', 'ga4-src', 'ga4']);
    expect(tags[0]!.inline).toContain("'GTM-TEST123'");
    expect(tags[1]!.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-TEST1234');
  });
});
