// Exact amounts (SPEC.md §4.4). An amount becomes a BigInt of minor units or a precise reason why not.
// No floating point touches an amount: text is converted digit by digit, and a JSON number (which
// sealed-audit-chain's parseJson reads as a double) is accepted only where the double is exact.

export type AmountFormat = 'minor_units' | 'decimal';

export type AmountProblem = 'BAD_AMOUNT' | 'FRACTIONAL_MINOR_UNITS' | 'AMOUNT_TOO_LARGE';

export type AmountResult = { ok: true; minor: bigint } | { ok: false; problem: AmountProblem; why: string };

/** ±(2^53 − 1) minor units: what JavaScript, JSON and most databases' bigint readers handle exactly. */
export const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

function inRange(minor: bigint): AmountResult {
  return minor > MAX_MINOR || minor < -MAX_MINOR
    ? { ok: false, problem: 'AMOUNT_TOO_LARGE', why: `is beyond ±${Number.MAX_SAFE_INTEGER} minor units` }
    : { ok: true, minor };
}

function fromText(text: string, format: AmountFormat, places: number): AmountResult {
  if (format === 'minor_units') {
    if (INTEGER.test(text)) return inRange(BigInt(text));
    if (DECIMAL.test(text)) {
      return { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: 'is not a whole number of minor units' };
    }
    return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a whole number of minor units' };
  }
  if (!DECIMAL.test(text)) return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a decimal amount such as 12.34' };
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  // Digits past the allowed places are fine only when they are zeros (12.340 is 12.34 exactly).
  if (/[1-9]/.test(fraction.slice(places))) {
    return { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: `has more than ${places} decimal place${places === 1 ? '' : 's'}` };
  }
  const digits = whole + fraction.slice(0, places).padEnd(places, '0');
  return inRange(BigInt(negative ? `-${digits}` : digits));
}

function fromNumber(value: number, format: AmountFormat, places: number): AmountResult {
  if (!Number.isFinite(value)) return { ok: false, problem: 'AMOUNT_TOO_LARGE', why: 'is too large to be an amount' };
  if (format === 'minor_units') {
    if (!Number.isInteger(value)) return { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: 'is not a whole number of minor units' };
    return Number.isSafeInteger(value) ? { ok: true, minor: BigInt(value) } : inRange(BigInt(value));
  }
  // The double's shortest round-trip text is the literal it came from whenever that literal had at most
  // 15 significant digits; more digits than that cannot be trusted to be what the file said.
  const text = String(value);
  if (text.includes('e')) {
    return Math.abs(value) >= 1
      ? { ok: false, problem: 'AMOUNT_TOO_LARGE', why: 'is too large to be an amount' }
      : { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: `has more than ${places} decimal places` };
  }
  // Zeros at either end are not significant: 100000 and 0.05 each have one significant digit.
  const significant = text.replace('-', '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (significant.length > 15) {
    return { ok: false, problem: 'BAD_AMOUNT', why: 'needs more than 15 significant digits; write it as a string' };
  }
  return fromText(text, format, places);
}

/**
 * Parse one amount. `null` means "no value" (missing, null or empty text), which the caller reports as
 * MISSING_VALUE or reads as 0 where an empty cell means zero (debit and credit columns).
 */
export function parseAmount(raw: unknown, format: AmountFormat, places: number): AmountResult | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') return fromNumber(raw, format, places);
  if (typeof raw !== 'string') return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a number' };
  const text = raw.trim();
  if (text === '') return null;
  return fromText(text, format, places);
}
