/**
 * Exact money arithmetic (D-013, D-041). Amounts are bigint counts of 1/10,000 of a currency unit,
 * so per-page prices (4 decimals) multiply without floating-point error. Results are rounded
 * half-up to cents only when a line amount, tax or total is produced.
 */

export const SCALE = 10_000n;

const AMOUNT_RE = /^(-)?(\d{1,13})(?:\.(\d{1,4}))?$/;

/** "12.5" | 12.5 | Prisma.Decimal → 125000n. Throws on anything else (no silent NaN). */
export function toUnits(value: string | number | { toString(): string }): bigint {
  const s = typeof value === 'number' ? value.toFixed(4) : String(value).trim();
  const m = AMOUNT_RE.exec(s);
  if (!m) throw new RangeError(`Not a money amount: ${s}`);
  const [, sign, whole, frac = ''] = m;
  const units = BigInt(whole!) * SCALE + BigInt(frac.padEnd(4, '0'));
  return sign ? -units : units;
}

/** Round half away from zero to a multiple of `step` units. */
function roundToStep(units: bigint, step: bigint): bigint {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const rounded = ((abs + step / 2n) / step) * step;
  return neg ? -rounded : rounded;
}

/** Round to whole cents (2 decimals). */
export const roundCents = (units: bigint): bigint => roundToStep(units, 100n);

/** Units → fixed decimal string, e.g. 125000n → "12.50" (decimals 2) or "12.5000" (decimals 4). */
export function formatUnits(units: bigint, decimals: 2 | 4 = 2): string {
  const v = decimals === 2 ? roundCents(units) : units;
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(4, '0').slice(0, decimals);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** quantity × unit price, both in units → cents-rounded units. */
export function multiply(quantity: bigint, unitPrice: bigint): bigint {
  const raw = quantity * unitPrice;
  // raw has SCALE² precision; divide back with half-up rounding, then round to cents.
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const scaled = (abs + SCALE / 2n) / SCALE;
  return roundCents(neg ? -scaled : scaled);
}

/** amount × percent / 100, cents-rounded. `percent` in units, e.g. 18% → 180000n. */
export function percentOf(amount: bigint, percent: bigint): bigint {
  return multiply(amount, percent / 100n);
}

export const sum = (values: bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/** Currencies without a minor unit in Stripe's API. */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** "12.34" USD → 1234 (cents); "500" JPY → 500. */
export function toMinorUnits(amount: string, currency: string): number {
  const cents = roundCents(toUnits(amount)) / 100n;
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return Number((cents + 50n) / 100n);
  return Number(cents);
}

/** 1234 (cents) USD → "12.34". */
export function fromMinorUnits(minor: number, currency: string): string {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return formatUnits(BigInt(minor) * SCALE);
  return formatUnits(BigInt(minor) * 100n);
}
