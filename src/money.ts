// Exact amounts (SPEC.md §4.4). An amount becomes a BigInt of minor units or a precise reason why not.
// No floating point touches an amount: text is converted digit by digit, and a JSON number arrives as
// the exact text the file wrote (src/ledger/json.ts), never as a 64-bit float.

import { JsonNumber, plainDecimal } from './ledger/json.js';

export type AmountFormat = 'minor_units' | 'decimal';

export type AmountProblem = 'BAD_AMOUNT' | 'FRACTIONAL_MINOR_UNITS' | 'AMOUNT_TOO_LARGE';

export type AmountResult = { ok: true; minor: bigint } | { ok: false; problem: AmountProblem; why: string };

/** ±(2^53 − 1) minor units: what JavaScript, JSON and most databases' bigint readers handle exactly. */
export const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** More whole digits than this is beyond MAX_MINOR whatever they are: refused before any BigInt is built. */
const MAX_WHOLE_DIGITS = 20;

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

const TOO_LARGE: AmountResult = { ok: false, problem: 'AMOUNT_TOO_LARGE', why: `is beyond ±${Number.MAX_SAFE_INTEGER} minor units` };

function inRange(sign: '' | '-', digits: string): AmountResult {
  // Leading zeros carry no value; a long run of other digits would make BigInt slow for nothing.
  const significant = digits.replace(/^0+(?=\d)/, '');
  if (significant.length > MAX_WHOLE_DIGITS) return TOO_LARGE;
  const minor = BigInt(`${sign}${significant}`);
  return minor > MAX_MINOR || minor < -MAX_MINOR ? TOO_LARGE : { ok: true, minor };
}

function fromText(text: string, format: AmountFormat, places: number): AmountResult {
  const sign = text.startsWith('-') ? '-' : '';
  if (format === 'minor_units') {
    if (INTEGER.test(text)) return inRange(sign, text.slice(sign.length));
    if (DECIMAL.test(text)) {
      return { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: 'is not a whole number of minor units' };
    }
    return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a whole number of minor units' };
  }
  if (!DECIMAL.test(text)) return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a decimal amount such as 12.34' };
  const [whole = '0', fraction = ''] = text.slice(sign.length).split('.');
  // Digits past the allowed places are fine only when they are zeros (12.340 is 12.34 exactly).
  if (/[1-9]/.test(fraction.slice(places))) {
    return { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: `has more than ${places} decimal place${places === 1 ? '' : 's'}` };
  }
  return inRange(sign, whole + fraction.slice(0, places).padEnd(places, '0'));
}

/**
 * A JSON number is judged by its exact value: 1000, 1000.0 and 1e3 are the same amount, and
 * 4503599627370496.5 is not a whole number, however large it is.
 */
function fromJsonNumber(value: JsonNumber, format: AmountFormat, places: number): AmountResult {
  const plain = plainDecimal(value);
  if (plain === 'too large') return TOO_LARGE;
  if (plain === 'too small') {
    return format === 'minor_units'
      ? { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: 'is not a whole number of minor units' }
      : { ok: false, problem: 'FRACTIONAL_MINOR_UNITS', why: `has more than ${places} decimal place${places === 1 ? '' : 's'}` };
  }
  return fromText(plain, format, places);
}

/**
 * Parse one amount. `null` means "no value" (missing, null or empty text), which the caller reports as
 * MISSING_VALUE or reads as 0 where an empty cell means zero (debit and credit columns).
 */
export function parseAmount(raw: unknown, format: AmountFormat, places: number): AmountResult | null {
  if (raw === undefined || raw === null) return null;
  if (raw instanceof JsonNumber) return fromJsonNumber(raw, format, places);
  if (typeof raw !== 'string') return { ok: false, problem: 'BAD_AMOUNT', why: 'is not a number' };
  const text = raw.trim();
  if (text === '') return null;
  return fromText(text, format, places);
}
