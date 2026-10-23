export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (code = 'unauthorized', message = 'Authentication required') =>
  new HttpError(401, code, message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new HttpError(403, 'forbidden', message);
/** Also used for resources the caller may not see, so existence is not leaked. */
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
export const tooMany = (message = 'Too many requests, try again later') =>
  new HttpError(429, 'rate_limited', message);
