import { errorInfo } from '@datascribe/db';
import { afterAll, describe, expect, it } from 'vitest';
import { orgId, prisma, uniqueEmail } from './helpers';

afterAll(() => prisma.$disconnect());

/** A synthetic value standing in for PHI that must never reach a log line. */
const MARKER = 'Synthetic-Patient-Zz9';

describe('error logging never carries values (audit L7)', () => {
  it('a Prisma validation error is reduced to its name', async () => {
    const err = await prisma.user
      // @ts-expect-error -- deliberately invalid: missing required fields
      .create({ data: { email: uniqueEmail('l7'), name: MARKER } })
      .catch((e: unknown) => e);
    // the raw message quotes the call's arguments: this is what must not be logged
    expect((err as Error).message).toContain(MARKER);
    const info = errorInfo(err);
    expect(info.name).toBe('PrismaClientValidationError');
    expect(JSON.stringify(info)).not.toContain(MARKER);
  });

  it('a unique violation keeps its code, model and column names, not the value', async () => {
    const email = `${MARKER.toLowerCase()}.${Date.now()}@test.example`;
    const data = {
      email,
      name: 'Synthetic Test User',
      organizationId: await orgId('acme'),
      passwordHash: 'x',
    };
    await prisma.user.create({ data });
    const err = await prisma.user.create({ data }).catch((e: unknown) => e);
    const info = errorInfo(err);
    expect(info).toMatchObject({ name: 'PrismaClientKnownRequestError', code: 'P2002' });
    expect(info.fields).toEqual(['email']);
    expect(JSON.stringify(info).toLowerCase()).not.toContain(MARKER.toLowerCase());
  });

  it('other errors keep their message; non-errors only their type', () => {
    expect(errorInfo(new Error('S3 unavailable'))).toEqual({
      name: 'Error',
      message: 'S3 unavailable',
    });
    expect(errorInfo('a string with data')).toEqual({ name: 'string' });
  });
});
