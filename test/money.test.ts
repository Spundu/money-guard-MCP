import { describe, expect, it } from 'vitest';
import { parseAmount, type AmountFormat } from '../src/money.js';

/** The parsed minor units, or the problem code, or "missing". */
function parsed(raw: unknown, format: AmountFormat = 'minor_units', places = 2): bigint | string {
  const r = parseAmount(raw, format, places);
  if (r === null) return 'missing';
  return r.ok ? r.minor : r.problem;
}

describe('parseAmount, minor_units', () => {
  it('reads whole numbers written as text, exactly', () => {
    expect(parsed('1234')).toBe(1234n);
    expect(parsed('-50')).toBe(-50n);
    expect(parsed(' 7 ')).toBe(7n);
    expect(parsed('007')).toBe(7n);
    expect(parsed('-0')).toBe(0n);
    expect(parsed('9007199254740991')).toBe(9007199254740991n);
  });

  it('refuses amounts beyond ±(2^53 - 1), however many digits they have', () => {
    expect(parsed('9007199254740992')).toBe('AMOUNT_TOO_LARGE');
    expect(parsed('-9007199254740992')).toBe('AMOUNT_TOO_LARGE');
    expect(parsed('9'.repeat(400))).toBe('AMOUNT_TOO_LARGE');
  });

  it('reports a decimal point as a fraction of a minor unit, even when the fraction is zero', () => {
    expect(parsed('12.5')).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed('12.00')).toBe('FRACTIONAL_MINOR_UNITS');
  });

  it('refuses text that is not a plain number', () => {
    for (const raw of ['1,234', '£12', '+12', '(12)', '1e3', '12 34', '١٢', '0x10', 'NaN', '-', '.5', '5.']) {
      expect(parsed(raw), raw).toBe('BAD_AMOUNT');
    }
    expect(parsed(true)).toBe('BAD_AMOUNT');
    expect(parsed({ value: 1 })).toBe('BAD_AMOUNT');
  });

  it('treats a missing value or empty text as no value', () => {
    for (const raw of [undefined, null, '', '   ']) expect(parsed(raw)).toBe('missing');
  });

  it('judges a JSON number by its value', () => {
    expect(parsed(1234)).toBe(1234n);
    expect(parsed(-1)).toBe(-1n);
    expect(parsed(12)).toBe(12n);
    expect(parsed(1e3)).toBe(1000n);
    expect(parsed(12.5)).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(2 ** 53)).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(Number.POSITIVE_INFINITY)).toBe('AMOUNT_TOO_LARGE');
  });
});

describe('parseAmount, decimal', () => {
  it('converts decimal text to minor units digit by digit', () => {
    expect(parsed('12.34', 'decimal')).toBe(1234n);
    expect(parsed('12.3', 'decimal')).toBe(1230n);
    expect(parsed('12', 'decimal')).toBe(1200n);
    expect(parsed('-0.01', 'decimal')).toBe(-1n);
    expect(parsed('0.10', 'decimal')).toBe(10n);
    expect(parsed('1500', 'decimal', 0)).toBe(1500n);
    expect(parsed('1.234', 'decimal', 3)).toBe(1234n);
  });

  it('accepts extra decimal places only when they are zeros', () => {
    expect(parsed('12.340', 'decimal')).toBe(1234n);
    expect(parsed('1500.0', 'decimal', 0)).toBe(1500n);
    expect(parsed('12.345', 'decimal')).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed('0.005', 'decimal')).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed('1500.5', 'decimal', 0)).toBe('FRACTIONAL_MINOR_UNITS');
  });

  it('refuses separators, symbols and exponents', () => {
    for (const raw of ['1,234.56', '€12.00', '12,50', '1.2e3', '-', '12.']) expect(parsed(raw, 'decimal'), raw).toBe('BAD_AMOUNT');
  });

  it('reads a JSON number through its shortest round-trip text, and refuses one that is not exact', () => {
    expect(parsed(12.34, 'decimal')).toBe(1234n);
    expect(parsed(0.1, 'decimal')).toBe(10n);
    expect(parsed(0.1 + 0.2, 'decimal')).toBe('BAD_AMOUNT'); // 0.30000000000000004: 17 significant digits
    expect(parsed(1e-7, 'decimal')).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(1e21, 'decimal')).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(1e20, 'decimal')).toBe('AMOUNT_TOO_LARGE'); // one significant digit, but 10^22 minor units
  });
});
