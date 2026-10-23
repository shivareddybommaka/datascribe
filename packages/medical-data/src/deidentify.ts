/**
 * deidentifyTerm(): the last gate before a term leaves Datascribe for a public API (§8.4).
 *
 * It strips identifiers (names, dates, record/case numbers, phones, emails, URLs, addresses, ages)
 * and refuses anything that is not a short clinical phrase. It errs on the side of removing too
 * much: a stripped clinical word costs one uncoded entry, a leaked identifier is a PHI disclosure.
 */

export type IdentifierKind =
  'email' | 'url' | 'phone' | 'ssn' | 'date' | 'record_number' | 'address' | 'age' | 'name';

export type RefusalReason = 'too_long' | 'empty';

export type DeidentifyResult =
  | { ok: true; term: string; removed: IdentifierKind[] }
  | { ok: false; reason: RefusalReason; removed: IdentifierKind[] };

export interface DeidentifyOptions {
  /** Identifiers known for this case (patient name, case number…); every part is stripped. */
  knownIdentifiers?: string[];
}

/** Raw input longer than this is free text, not a term, and is refused before any parsing. */
export const MAX_RAW_LENGTH = 200;
/** Limits for the cleaned term: "type 2 diabetes mellitus with diabetic neuropathy" fits. */
export const MAX_TERM_LENGTH = 100;
export const MAX_TERM_WORDS = 10;

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

/** Abbreviated street types are only trusted after a capitalised word ("12 Main St"). */
const STREET_ABBR =
  'St|Ave|Rd|Blvd|Ln|Dr|Ct|Pl|Tce|Pkwy|Hwy|Cir|Cres|Sq|Street|Avenue|Road|Boulevard|Lane|Drive|Court|Way|Place|Terrace|Parkway|Highway|Circle|Crescent|Close|Square';
const STREET_WORDS =
  'street|avenue|road|boulevard|lane|drive|court|parkway|highway|terrace|crescent';

const US_STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

/** Units that may follow a number in a dose, so "2000 units" is not mistaken for a year. */
const UNIT = '(?:mg|mcg|µg|ug|g|kg|ml|l|units?|iu|meq|mmol|tabs?|caps?)';

const NAME_LABEL =
  '(?:patient(?:\\s+name)?|pt|name|client|claimant|plaintiff|defendant|decedent|insured|member|re|attn|signed\\s+by|seen\\s+by|referred\\s+by|provider|physician|doctor|nurse)';

interface Rule {
  kind: IdentifierKind;
  re: RegExp;
  /** Extra check on a match (`after` is the text following it); returning false keeps the text. */
  when?: (match: string, after: string) => boolean;
  /** Custom replacement; defaults to a space. */
  replace?: (match: string) => string;
}

const digitCount = (s: string) => s.replace(/\D/g, '').length;
const startsWithUnit = new RegExp(`^\\s*${UNIT}\\b`, 'i');

/**
 * After a name label ("Patient:"), drop the capitalised words that follow. If none are
 * capitalised (a lower-case name), drop the next two words: losing a clinical word is the safer error.
 */
function dropLabelledName(match: string): string {
  const [, rest = ''] = /^[^:-]*[:-]\s*(.*)$/s.exec(match) ?? [];
  const words = rest.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Z]/.test(words[i]!)) i++;
  if (i === 0) i = Math.min(2, words.length);
  return ` ${words.slice(i).join(' ')} `;
}

/** Ordered: broad structured identifiers first so later rules don't split them. */
const RULES: Rule[] = [
  { kind: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi },
  { kind: 'url', re: /\b(?:https?:\/\/|www\.)\S+/gi },
  {
    kind: 'ssn',
    re: /(?:\b(?:ssn|social\s+security(?:\s+(?:number|no\.?))?)\s*[:#]?\s*)?\b\d{3}-\d{2}-\d{4}\b/gi,
  },
  // Dates with an explicit label, whatever format follows.
  {
    kind: 'date',
    re: new RegExp(
      `\\b(?:d\\.?o\\.?b\\.?|date\\s+of\\s+(?:birth|death|service|injury|admission|discharge)|born|dos|doi)(?![\\w])\\s*[:#-]?\\s*(?:[\\d/.-]+|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s*\\d{2,4})?`,
      'gi',
    ),
  },
  // 2024-03-15, 03/15/2024, 15.3.24, 3-15-80
  { kind: 'date', re: /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g },
  // March 15, 2024 / Mar 15 2024 / 15 March 2024 / 15th of March / March 2024
  {
    kind: 'date',
    re: new RegExp(
      `\\b(?:\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\.?,?(?:\\s+\\d{2,4})?|(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?|(?:${MONTHS})\\.?,?\\s+\\d{4})\\b`,
      'gi',
    ),
  },
  // Month/year: 03/2024
  { kind: 'date', re: /\b\d{1,2}\/\d{4}\b/g },
  // Labelled record, case, claim, account and member numbers.
  {
    kind: 'record_number',
    re: /\b(?:mrn|mr\s*#|medical\s+record(?:\s+(?:number|no\.?|#))?|chart(?:\s+(?:number|no\.?|#))?|case(?:\s+(?:number|no\.?|#|id))?|claim(?:\s+(?:number|no\.?|#))?|docket|acct|account(?:\s+(?:number|no\.?|#))?|member\s+id|patient\s+id|policy(?:\s+(?:number|no\.?|#))?|encounter|visit\s+id|ssn|id)\s*[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]*/gi,
  },
  // Court docket style: 2:24-cv-01234
  { kind: 'record_number', re: /\b\d{1,2}:\d{2}-[a-z]{2}-\d{3,}\b/gi },
  // Street addresses ("12 Main St", "4 north harbour road"), PO boxes, units, "IL 62704".
  {
    kind: 'address',
    re: new RegExp(
      `\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z][A-Za-z.'-]*\\s+){1,4}(?:${STREET_ABBR})\\b\\.?`,
      'g',
    ),
  },
  {
    kind: 'address',
    re: new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[a-z.'-]+\\s+){0,4}(?:${STREET_WORDS})\\b`, 'gi'),
  },
  { kind: 'address', re: /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\s*\d+/gi },
  { kind: 'address', re: /\b(?:apt|apartment|unit|suite|ste)\.?\s*#?\s*\d+[a-z]?\b/gi },
  { kind: 'address', re: new RegExp(`\\b(?:${US_STATES})\\s+\\d{5}(?:-\\d{4})?\\b`, 'g') },
  // Phone numbers: labelled, or any run of 7+ digits with phone separators.
  { kind: 'phone', re: /\b(?:tel|phone|ph|mobile|cell|fax)\s*[:.]?\s*\+?[\d\s().-]{5,}\d/gi },
  {
    kind: 'phone',
    re: /(?<![\w.])\+?\(?\d[\d\s().-]{5,}\d(?![\w])/g,
    // "gabapentin 300 600 900 mg" is a dose list, not a phone number
    when: (m, after) => digitCount(m) >= 7 && !startsWithUnit.test(after),
  },
  // Ages. HIPAA Safe Harbor only requires ages over 89 to go, but no age helps coding, so all go.
  {
    kind: 'age',
    re: /\b(?:aged?\s*[:-]?\s*)?\d{1,3}\s*-?\s*(?:years?|yrs?|y)\s*-?\s*(?:old|o\b|\/o)|\b\d{1,3}\s*(?:yo|y\/o|y\.o\.?)(?=\W|$)|\bage[ds]?\s*[:-]?\s*\d{1,3}\b|\b\d{1,3}\s*(?:years?|yrs?)\s+of\s+age\b/gi,
  },
  // Names: Synthea-style (Ramiro608 Jacobs452), honorific + capitalised words, labelled names.
  { kind: 'name', re: /\b[A-Za-z][a-z]+\d{2,}\b/g },
  {
    kind: 'name',
    re: /\b(?:[Mm]rs?|[Mm]s|[Mm]iss|[Mm]x|[Dd]r|[Pp]rof)\.?\s+(?:[A-Z][a-zA-Z\d'-]*\.?\s*){1,3}/g,
  },
  {
    kind: 'name',
    re: new RegExp(`\\b${NAME_LABEL}\\s*[:\\-]\\s*(?:[A-Za-z][a-zA-Z'.-]*,?\\s*){1,3}`, 'gi'),
    replace: dropLabelledName,
  },
  {
    kind: 'name',
    re: /\b(?:[Pp]atient|PATIENT|[Pp]t|[Cc]laimant|[Pp]laintiff|[Cc]lient|[Dd]ecedent)\s+(?:[A-Z][a-z'-]+\s*){1,3}/g,
  },
  // Possessive full name in front of a finding: "John Smith's".
  { kind: 'name', re: /\b[A-Z][a-z]+\s+[A-Z][a-z]+'s\b/g },
  // An honorific left dangling once its name was removed by an earlier rule.
  { kind: 'name', re: /\b(?:Mrs?|Ms|Miss|Mx|Dr|Prof)\b\.?(?=\s|$)/g },
  // Anything left with 5+ digits in a row is an identifier (MRN, ZIP/PIN, account), not a term.
  { kind: 'record_number', re: /\b[A-Z]{0,4}[-#]?\d{5,}[A-Z]?\b/gi },
  // Bare years (but not doses like "2000 units").
  { kind: 'date', re: new RegExp(`\\b(?:19|20)\\d{2}\\b(?!\\s*${UNIT}\\b)`, 'gi') },
];

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripKnown(text: string, known: string[], removed: Set<IdentifierKind>): string {
  let out = text;
  const parts = known
    .flatMap((k) => [k, ...k.split(/[\s,]+/)])
    .map((p) => p.trim())
    .filter((p) => p.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const part of parts) {
    const re = new RegExp(`(?<![\\w])${escapeRegExp(part)}(?![\\w])`, 'gi');
    if (re.test(out)) {
      removed.add(/\d/.test(part) ? 'record_number' : 'name');
      re.lastIndex = 0;
      out = out.replace(re, ' ');
    }
  }
  return out;
}

/** Collapse leftovers: label debris ("DOB:"), dangling punctuation and spaces. */
function tidy(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/[;|"<>{}[\]\\`*]/g, ' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+([,:#.])/g, '$1')
      .replace(/([,:#])(?=[,:#])/g, '')
      .replace(/^[\s,:#().'-]+|[\s,:#(-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function deidentifyTerm(input: string, opts: DeidentifyOptions = {}): DeidentifyResult {
  const removed = new Set<IdentifierKind>();
  const done = (r: { ok: true; term: string } | { ok: false; reason: RefusalReason }) =>
    ({ ...r, removed: [...removed] }) as DeidentifyResult;

  if (input.length > MAX_RAW_LENGTH) return done({ ok: false, reason: 'too_long' });

  let text = input.normalize('NFKC');
  if (opts.knownIdentifiers?.length) text = stripKnown(text, opts.knownIdentifiers, removed);
  for (const { kind, re, when, replace } of RULES) {
    re.lastIndex = 0;
    text = text.replace(re, (m: string, ...rest: unknown[]) => {
      const offset = rest.find((x) => typeof x === 'number') as number;
      if (when && !when(m, text.slice(offset + m.length))) return m;
      removed.add(kind);
      return replace ? replace(m) : ' ';
    });
  }
  const term = tidy(text);

  if (!/\p{L}/u.test(term)) return done({ ok: false, reason: 'empty' });
  if (term.length > MAX_TERM_LENGTH || term.split(' ').length > MAX_TERM_WORDS) {
    return done({ ok: false, reason: 'too_long' });
  }
  return done({ ok: true, term });
}

/** Thrown by adapters when a term is refused; callers treat it as "uncoded". */
export class TermRefusedError extends Error {
  constructor(public readonly reason: RefusalReason) {
    super(`Term refused: ${reason}`);
    this.name = 'TermRefusedError';
  }
}

/** Adapter-side gate: returns the clean term or throws TermRefusedError. */
export function requireSafeTerm(input: string, opts?: DeidentifyOptions): string {
  const r = deidentifyTerm(input, opts);
  if (!r.ok) throw new TermRefusedError(r.reason);
  return r.term;
}
