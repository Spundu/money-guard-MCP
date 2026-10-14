// The ledger's JSON parser (src/ledger/json.ts): strict RFC 8259, never JSON.parse, and numbers kept as
// the exact text the file wrote.
import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonSyntaxError, parseLedgerJson, plainDecimal } from '../src/ledger/json.js';

const parse = (text: string) => parseLedgerJson(text, 100);
const n = (text: string) => new JsonNumber(text);

describe('parseLedgerJson', () => {
  it('keeps every number as the exact text the file wrote', () => {
    expect(parse('[1, -0, 12.50, 1e3, 4503599627370496.5, 1234567890123456789]')).toEqual([
      n('1'),
      n('-0'),
      n('12.50'),
      n('1e3'),
      n('4503599627370496.5'),
      n('1234567890123456789'),
    ]);
  });

  it('reads strings, escapes, objects and literals as RFC 8259 says', () => {
    expect(parse('{"a":"x\\ny\\u00e9","b":[true,false,null],"c":{"\\ud83d\\ude00":"\\/"}}')).toEqual({ a: 'x\nyé', b: [true, false, null], c: { '😀': '/' } });
  });

  it('reads every hex digit of an escape, in either letter case (.NET writes them in capitals)', () => {
    const escapes = ['0123', '4567', '89ab', 'cdef', '89AB', 'CDEF'].map((hex) => `\\u${hex}`).join('');
    expect(parse(`"${escapes}"`)).toBe(String.fromCharCode(0x0123, 0x4567, 0x89ab, 0xcdef, 0x89ab, 0xcdef));
  });

  it('keeps "__proto__" as an ordinary key, and the last of duplicate keys', () => {
    const value = parse('{"__proto__":{"x":1},"k":1,"k":2}') as Record<string, unknown>;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(value.k).toEqual(n('2'));
  });

  it('reads escaped one-character keys right, whatever it parsed before (V8 12.9+ JSON.parse can return the wrong key)', () => {
    parse('{"a":1,"\\\\":2}');
    expect(Object.keys(parse('{"a":1,"\\n":2}') as object)).toEqual(['a', '\n']);
  });

  it('refuses what RFC 8259 refuses, saying where', () => {
    for (const bad of ['', '[1,]', '{"a":1,}', '01', '+1', '.5', '1.', '1e', 'NaN', 'Infinity', '[1 2]', '{a:1}', "'a'", '"\u0001"', '"\\x"', '[] []', '{"a"}', '"abc']) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(JsonSyntaxError);
    }
    expect(() => parse('[1,]')).toThrow(/ at position 3$/);
  });

  it('refuses nesting deeper than the limit', () => {
    expect(() => parse(`${'['.repeat(101)}${']'.repeat(101)}`)).toThrow(/^nesting deeper than 100/);
    expect(parse(`${'['.repeat(100)}${']'.repeat(100)}`)).toBeInstanceOf(Array);
  });
});

describe('plainDecimal', () => {
  it.each([
    ['0', '0'],
    ['-0', '0'],
    ['-0.0', '0'],
    ['0e999999999', '0'],
    ['12', '12'],
    ['12.50', '12.5'],
    ['100', '100'],
    ['1e3', '1000'],
    ['1E+3', '1000'],
    ['0.05', '0.05'],
    ['1.5e-1', '0.15'],
    ['-12.3e1', '-123'],
    ['4503599627370496.5', '4503599627370496.5'],
    ['1234567890123456789', '1234567890123456789'],
    ['1e399', `1${'0'.repeat(399)}`],
    ['1e-401', `0.${'0'.repeat(400)}1`],
  ])('reads %s as %s', (text, plain) => {
    expect(plainDecimal(n(text))).toBe(plain);
  });

  it('says "too large" or "too small" past 400 places, without building the text', () => {
    expect(plainDecimal(n('1e400'))).toBe('too large');
    expect(plainDecimal(n('1e-402'))).toBe('too small');
    expect(plainDecimal(n('1e99999999999999999999'))).toBe('too large');
    expect(plainDecimal(n('-1e-99999999999999999999'))).toBe('too small');
  });

  it('takes time in proportion to the length, even for a long run of zeros between other digits', () => {
    // "1", zeros, "1": the shape on which a regular expression that strips trailing zeros backtracks
    // through the whole run from every zero (150,000 zeros took about 14 seconds).
    const zeros = '0'.repeat(150_000);
    const started = performance.now();
    expect(plainDecimal(n(`1${zeros}1`))).toBe('too large');
    expect(plainDecimal(n(`-1${zeros}1e-150001`))).toBe(`-1.${zeros}1`);
    expect(plainDecimal(n(`0.${zeros}1${zeros}`))).toBe('too small');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('reads a long exponent that a long mantissa moves back: the value decides, not the exponent alone', () => {
    expect(plainDecimal(n(`1${'0'.repeat(2_000_000)}e-1999998`))).toBe('100');
    expect(plainDecimal(n(`0.${'0'.repeat(2_000_000)}1e2000003`))).toBe('100');
  });
});
