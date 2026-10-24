/**
 * Sentry configuration and PHI scrubbing shared by the API, the worker and the web app (D-119).
 *
 * Sentry is off unless a DSN is set. Everything that leaves a process goes through
 * {@link scrubEvent} / {@link scrubBreadcrumb} / {@link scrubTransaction} first, which keep the
 * shape of an error (type, stack frames, route) and drop or redact anything that could carry PHI,
 * credentials or tokens: request bodies, cookies, auth headers, query strings, user details, local
 * variables, PHI-named fields and free-text patterns (emails, dates, long numbers, tokens).
 *
 * No Node imports and no Sentry imports: the browser bundle reads it too, and the shapes below
 * are the Sentry event protocol, typed loosely so the scrubber accepts any SDK's event type.
 */

type Raw = Record<string, string | undefined>;
type Obj = Record<string, unknown>;

export interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  /** 0..1, share of requests traced; 0 = errors only (the default) */
  tracesSampleRate: number;
  /** never send IPs, cookies, user details or request bodies by default */
  sendDefaultPii: false;
  maxBreadcrumbs: number;
}

/** Variable names for one process: the web app reads the NEXT_PUBLIC_ ones (inlined at build). */
export interface SentryEnvKeys {
  dsn: string;
  tracesSampleRate: string;
  environment: string;
  release: string;
}

export const SERVER_SENTRY_KEYS: SentryEnvKeys = {
  dsn: 'SENTRY_DSN',
  tracesSampleRate: 'SENTRY_TRACES_SAMPLE_RATE',
  environment: 'SENTRY_ENVIRONMENT',
  release: 'SENTRY_RELEASE',
};

export const WEB_SENTRY_KEYS: SentryEnvKeys = {
  dsn: 'NEXT_PUBLIC_SENTRY_DSN',
  tracesSampleRate: 'NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE',
  environment: 'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
  release: 'NEXT_PUBLIC_SENTRY_RELEASE',
};

const trimmed = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

const parseRate = (v: string | undefined): number | null => {
  const s = trimmed(v);
  if (s === undefined) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/** Start-up checks: names and reasons only, never values. */
export function sentryEnvIssues(
  env: Raw,
  keys: SentryEnvKeys = SERVER_SENTRY_KEYS,
): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const dsn = trimmed(env[keys.dsn]);
  if (dsn) {
    let ok = false;
    try {
      const url = new URL(dsn);
      ok = (url.protocol === 'https:' || url.protocol === 'http:') && !!url.username;
    } catch {
      ok = false;
    }
    if (!ok) issues.push({ path: keys.dsn, message: 'must be a Sentry DSN (https://key@host/id)' });
  }
  if (parseRate(env[keys.tracesSampleRate]) === null) {
    issues.push({ path: keys.tracesSampleRate, message: 'must be a number from 0 to 1' });
  }
  return issues;
}

/**
 * Options for `Sentry.init`, or null when Sentry is off (no DSN). An invalid sample rate falls
 * back to 0 here; the API and worker refuse to start with one ({@link sentryEnvIssues}).
 * `environment` defaults to the deploy profile (local / staging / production).
 */
export function sentryConfig(
  env: Raw,
  deployEnv: string,
  keys: SentryEnvKeys = SERVER_SENTRY_KEYS,
): SentryConfig | null {
  const dsn = trimmed(env[keys.dsn]);
  if (!dsn) return null;
  const release = trimmed(env[keys.release]);
  return {
    dsn,
    environment: trimmed(env[keys.environment]) ?? deployEnv,
    ...(release ? { release } : {}),
    tracesSampleRate: parseRate(env[keys.tracesSampleRate]) ?? 0,
    sendDefaultPii: false,
    maxBreadcrumbs: 50,
  };
}

// ───────────────────────────── scrubbing ─────────────────────────────

export const REDACTED = '[redacted]';
const MAX_TEXT = 300;
const MAX_DEPTH = 8;

/** Field names (lower-case, separators removed) whose values are always dropped. */
const SENSITIVE_EXACT = new Set([
  'text',
  'body',
  'data',
  'note',
  'notes',
  'dob',
  'ssn',
  'mrn',
  'iv',
  'name',
  'query',
  'querystring',
  'search',
  'params',
  'args',
  'input',
  'value',
  'values',
  'variables',
  'vars',
  'env',
]);
const SENSITIVE_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'auth',
  'cookie',
  'session',
  'csrf',
  'jwt',
  'apikey',
  'privatekey',
  'signature',
  'credential',
  'patient',
  'birth',
  'diagnos',
  'chronolog',
  'summary',
  'cipher',
  'encrypt',
  'phi',
  'email',
  'phone',
  'address',
  'filename',
  'firstname',
  'lastname',
  'fullname',
  'username',
  'displayname',
  'mattername',
  'reference',
  'casenote',
  'content',
  'statement',
  'message',
  'description',
];

const normalizeKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  return SENSITIVE_EXACT.has(k) || SENSITIVE_PARTS.some((p) => k.includes(p));
}

/** Path segments that are secrets (invite, reset, relay tokens) whatever their shape. */
const TOKEN_ROUTES = /\/(invites?|reset-password|storage-relay|verify-email|verify)\/[^/?#]+/g;
/** Long opaque segments: tokens, JWTs, signed keys (ids are redacted too; harmless). */
const TOKEN_SEGMENT = /^[A-Za-z0-9_.~%-]{24,}$/;

/** Drops the query string and fragment and replaces token-like path segments. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut >= 0 ? url.slice(0, cut) : url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(base);
  // drop user:password@ from absolute URLs
  const origin = m ? m[1]!.replace(/\/\/[^@/]*@/, '//') : '';
  const path = (m ? m[2]! : base)
    .replace(TOKEN_ROUTES, (_s, route: string) => `/${route}/${REDACTED}`)
    .split('/')
    .map((seg) => (TOKEN_SEGMENT.test(seg) ? REDACTED : seg))
    .join('/');
  return origin + path;
}

const TEXT_PATTERNS: [RegExp, string | ((s: string) => string)][] = [
  // URLs first, so their query strings go before the token patterns see them
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (u) => scrubUrl(u)],
  [/\/[A-Za-z0-9_./-]*\?[^\s"'<>]*/g, (u) => scrubUrl(u)],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [token]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, '[token]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // values quoted in double quotes (JSON.parse, Prisma, Zod quote their input that way)
  [/"[^"\n]{1,200}"/g, `"${REDACTED}"`],
  [/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}[0-9:.]*Z?)?\b/g, '[date]'],
  [/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g, '[date]'],
  // six or more digits: phone, MRN, SSN, account numbers (versions like 10.76.2 stay)
  [/\+?\d(?:[\s().-]?\d){5,}/g, '[number]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[token]'],
];

/**
 * Free text (exception and log messages, breadcrumb messages): patterns that can carry PHI or
 * secrets are replaced and the text is capped. Names in prose can't be recognised, so code must
 * still never put PHI into error messages (CLAUDE.md rule, D-105).
 */
export function redactText(text: string): string {
  let out = text;
  for (const [re, rep] of TEXT_PATTERNS) {
    out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
  }
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out;
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const without = (o: Obj, key: string): Obj => {
  const copy = { ...o };
  delete copy[key];
  return copy;
};

/** Drops sensitive keys and redacts free text in every remaining string, recursively. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : scrubValue(v, depth + 1);
  }
  return out;
}

/** Headers that say nothing about the person or their session. Everything else is dropped. */
const SAFE_HEADERS = new Set([
  'accept',
  'content-type',
  'content-length',
  'x-request-id',
  'sentry-trace',
  'baggage',
]);

function scrubRequest(request: Obj): Obj {
  const out: Obj = {};
  if (typeof request.method === 'string') out.method = request.method;
  if (typeof request.url === 'string') out.url = scrubUrl(request.url);
  if (isObj(request.headers)) {
    const headers: Obj = {};
    for (const [k, v] of Object.entries(request.headers)) {
      if (SAFE_HEADERS.has(k.toLowerCase()) && typeof v === 'string') headers[k] = redactText(v);
    }
    out.headers = headers;
  }
  // cookies, data (body), query_string and env (REMOTE_ADDR …) are never sent
  return out;
}

/** Errors whose messages quote input values (Prisma queries, Zod issues). */
const VALUE_QUOTING_ERRORS = /^(PrismaClient|Zod|Validation)/;

function scrubException(ex: Obj): Obj {
  const out: Obj = { ...ex };
  if (typeof ex.value === 'string') {
    out.value =
      typeof ex.type === 'string' && VALUE_QUOTING_ERRORS.test(ex.type)
        ? REDACTED
        : redactText(ex.value);
  }
  if (isObj(ex.mechanism)) out.mechanism = without(ex.mechanism, 'data');
  if (isObj(ex.stacktrace) && Array.isArray(ex.stacktrace.frames)) {
    out.stacktrace = {
      ...ex.stacktrace,
      // local variables never leave the process
      frames: ex.stacktrace.frames.map((f) => (isObj(f) ? without(f, 'vars') : f)),
    };
  }
  return out;
}

function scrubSpan(span: Obj): Obj {
  const out: Obj = { ...span };
  const op = typeof span.op === 'string' ? span.op : '';
  if (typeof span.description === 'string') {
    // SQL, Redis commands and their keys (which can hold emails) stay out
    out.description = /^(db|cache|redis)/.test(op) ? op : redactText(span.description);
  }
  if (isObj(span.data)) out.data = scrubValue(span.data);
  return out;
}

/**
 * Error events (`beforeSend`). Returns a new event; the input is not modified. Only the request
 * method, scrubbed URL and a few harmless headers, the user's id, and redacted text are kept.
 */
export function scrubEvent<E>(event: E): E {
  const src = event as unknown as Obj;
  const out: Obj = { ...src };
  if (isObj(src.request)) out.request = scrubRequest(src.request);
  if (isObj(src.user)) {
    out.user = typeof src.user.id === 'string' ? { id: src.user.id } : {};
  }
  if (typeof src.message === 'string') out.message = redactText(src.message);
  if (isObj(src.logentry)) {
    const msg = src.logentry.message ?? src.logentry.formatted;
    out.logentry = { message: typeof msg === 'string' ? redactText(msg) : REDACTED };
  }
  if (isObj(src.exception) && Array.isArray(src.exception.values)) {
    out.exception = {
      ...src.exception,
      values: src.exception.values.map((v) => (isObj(v) ? scrubException(v) : v)),
    };
  }
  if (typeof src.transaction === 'string') out.transaction = scrubUrl(src.transaction);
  if (src.extra !== undefined) out.extra = scrubValue(src.extra);
  if (src.contexts !== undefined) out.contexts = scrubValue(src.contexts);
  if (src.tags !== undefined) out.tags = scrubValue(src.tags);
  if (Array.isArray(src.breadcrumbs)) {
    out.breadcrumbs = src.breadcrumbs
      .map((b) => (isObj(b) ? scrubBreadcrumb(b) : null))
      .filter((b) => b !== null);
  }
  if (Array.isArray(src.spans)) {
    out.spans = src.spans.map((s) => (isObj(s) ? scrubSpan(s) : s));
  }
  return out as E;
}

/** Performance events (`beforeSendTransaction`): same rules as errors, spans included. */
export const scrubTransaction = scrubEvent;

/**
 * Breadcrumbs (`beforeBreadcrumb`), or null to drop one. Console output is dropped (it can hold
 * anything), UI breadcrumbs keep only their category (element labels can name a patient), and
 * HTTP / navigation breadcrumbs keep method, status and scrubbed URLs.
 */
export function scrubBreadcrumb<B>(breadcrumb: B): B | null {
  const b = breadcrumb as unknown as Obj;
  const category = typeof b.category === 'string' ? b.category : '';
  if (category === 'console') return null;
  const base: Obj = {};
  for (const k of ['type', 'category', 'level', 'timestamp'] as const) {
    if (b[k] !== undefined) base[k] = b[k];
  }
  if (category.startsWith('ui.')) return base as B;
  const data = isObj(b.data) ? b.data : undefined;
  if (category === 'fetch' || category === 'xhr' || category === 'http') {
    if (data) {
      const kept: Obj = {};
      if (typeof data.method === 'string') kept.method = data.method;
      if (typeof data.status_code === 'number') kept.status_code = data.status_code;
      if (typeof data.url === 'string') kept.url = scrubUrl(data.url);
      base.data = kept;
    }
    return base as B;
  }
  if (category === 'navigation') {
    if (data) {
      const kept: Obj = {};
      if (typeof data.from === 'string') kept.from = scrubUrl(data.from);
      if (typeof data.to === 'string') kept.to = scrubUrl(data.to);
      base.data = kept;
    }
    return base as B;
  }
  if (typeof b.message === 'string') base.message = redactText(b.message);
  if (data) base.data = scrubValue(data);
  return base as B;
}
