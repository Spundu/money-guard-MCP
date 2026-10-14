import { describe, expect, it } from 'vitest';
import { JsonNumber } from '../src/ledger/json.js';
import { parseAmount, type AmountFormat } from '../src/money.js';

const n = (text: string) => new JsonNumber(text);

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

  it('judges a JSON number by its exact value, as the file wrote it', () => {
    expect(parsed(n('1234'))).toBe(1234n);
    expect(parsed(n('-1'))).toBe(-1n);
    expect(parsed(n('12.0'))).toBe(12n);
    expect(parsed(n('1e3'))).toBe(1000n);
    expect(parsed(n('-0'))).toBe(0n);
    expect(parsed(n('12.5'))).toBe('FRACTIONAL_MINOR_UNITS');
    // A 64-bit float rounds both of these to whole numbers.
    expect(parsed(n('4503599627370496.5'))).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(n('1.00000000000000001'))).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(n('9007199254740991'))).toBe(9007199254740991n);
    expect(parsed(n('9007199254740992'))).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(n('1e400'))).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(n('1e-400'))).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(n('1e99999999999999999999'))).toBe('AMOUNT_TOO_LARGE');
  });

  it('refuses a huge run of digits at once, without building a BigInt of it', () => {
    const started = performance.now();
    expect(parsed('9'.repeat(1_000_000))).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(n(`1${'0'.repeat(1_000_000)}`))).toBe('AMOUNT_TOO_LARGE');
    expect(parsed(`000000000000000000000000000000${'1'.repeat(15)}`)).toBe(111111111111111n); // leading zeros are no value
    expect(performance.now() - started).toBeLessThan(200);
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

  it('reads a JSON number exactly, at any length', () => {
    expect(parsed(n('12.34'), 'decimal')).toBe(1234n);
    expect(parsed(n('0.1'), 'decimal')).toBe(10n);
    expect(parsed(n('1.234e1'), 'decimal')).toBe(1234n);
    expect(parsed(n('12.340000000000000000'), 'decimal')).toBe(1234n);
    expect(parsed(n('12.340000000000000001'), 'decimal')).toBe('FRACTIONAL_MINOR_UNITS'); // a float reads 12.34
    expect(parsed(n('0.30000000000000004'), 'decimal')).toBe('FRACTIONAL_MINOR_UNITS'); // 0.1 + 0.2 as a float prints
    expect(parsed(n('1e-7'), 'decimal')).toBe('FRACTIONAL_MINOR_UNITS');
    expect(parsed(n('1e20'), 'decimal')).toBe('AMOUNT_TOO_LARGE'); // 10^22 minor units
  });

  it('never takes a JavaScript number: a value from a file is text or a JsonNumber', () => {
    expect(parsed(1234)).toBe('BAD_AMOUNT');
  });
});
