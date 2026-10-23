import type { ZodType, ZodTypeDef } from 'zod';
import { badRequest } from './errors';

/** Parse untrusted input; on failure throw a 400 listing field paths (never the submitted values). */
export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest('validation_failed', 'Invalid request', fields);
  }
  return result.data;
}
