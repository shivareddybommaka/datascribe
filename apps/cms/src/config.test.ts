import { PAGE_SLUGS } from '@datascribe/site-content';
import type { Access, Field } from 'payload';
import { describe, expect, it } from 'vitest';
import { publishedOrSignedIn, signedIn } from './access';
import { Pages } from './collections/Pages';
import { Posts } from './collections/Posts';
import { Users } from './collections/Users';
import { ctaFields, slugField } from './fields';
import { Site } from './globals/Site';

const field = (fields: Field[], name: string) =>
  fields.find((f) => 'name' in f && f.name === name) as Field & Record<string, unknown>;

const call = (access: Access, user: unknown) =>
  access({ req: { user } } as unknown as Parameters<Access>[0]);

describe('CMS collections', () => {
  it('pages offer exactly the 7 marketing slugs, each unique', () => {
    const slug = field(Pages.fields, 'slug') as { options: { value: string }[]; unique: boolean };
    expect(slug.options.map((o) => o.value)).toEqual([...PAGE_SLUGS]);
    expect(slug.unique).toBe(true);
  });

  it('pages and posts carry SEO fields (title, description, OG image)', () => {
    for (const c of [Pages, Posts]) {
      const seo = field(c.fields, 'seo') as { fields: Field[] };
      expect(seo.fields.map((f) => ('name' in f ? f.name : ''))).toEqual([
        'title',
        'description',
        'ogImage',
      ]);
    }
  });

  it('anonymous readers see published content only; editors see drafts', () => {
    expect(call(publishedOrSignedIn, null)).toEqual({ _status: { equals: 'published' } });
    expect(call(publishedOrSignedIn, { id: 1 })).toBe(true);
    expect(Pages.access?.read).toBe(publishedOrSignedIn);
    expect(Posts.access?.read).toBe(publishedOrSignedIn);
  });

  it('only signed-in CMS users can write content or see CMS users', () => {
    expect(call(signedIn, null)).toBe(false);
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(Pages.access?.[op]).toBe(signedIn);
      expect(Posts.access?.[op]).toBe(signedIn);
    }
    expect(Users.access?.read).toBe(signedIn);
    expect(Site.access?.update).toBe(signedIn);
  });
});

describe('field validation', () => {
  const validateHref = (field(ctaFields(), 'href') as { validate: (v: unknown) => unknown })
    .validate;

  it('CTA links must be site paths or https URLs', () => {
    expect(validateHref('/pricing')).toBe(true);
    expect(validateHref('https://example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', '//evil.example', 'http://x.example', '']) {
      expect(validateHref(bad)).not.toBe(true);
    }
  });

  it('post slugs are generated from the title when empty', () => {
    const f = slugField('title') as {
      hooks: { beforeValidate: ((a: { value: unknown; data: unknown }) => unknown)[] };
      validate: (v: unknown) => unknown;
    };
    const hook = f.hooks.beforeValidate[0]!;
    expect(hook({ value: '', data: { title: 'What’s new in 2026?' } })).toBe('what-s-new-in-2026');
    expect(hook({ value: 'kept', data: { title: 'x' } })).toBe('kept');
    expect(f.validate('Bad Slug')).not.toBe(true);
  });
});
