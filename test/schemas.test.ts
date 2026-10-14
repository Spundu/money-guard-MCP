// The input schemas run on every call, before any handler, so they must be cheap on hostile input.
import { describe, expect, it } from 'vitest';
import { POINTER, ledgerInput } from '../src/schemas.js';

const call = (columns: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ledgerInput.safeParse({ file: 'exports/ledger.json', columns: { transaction_id: 'id', ...columns }, ...extra });

describe('the JSON Pointer rule', () => {
  it('accepts RFC 6901 pointers and refuses the rest', () => {
    for (const ok of ['', '/', '/data/entries', '/a~0b/~1c', '//', '/a//b', `/${'x'.repeat(300)}`]) expect(POINTER.test(ok), ok).toBe(true);
    for (const bad of ['a', 'data/entries', '/a~2', '/a~', '/~']) expect(POINTER.test(bad), bad).toBe(false);
  });

  it('answers at once on a long run of slashes that cannot match (no catastrophic backtracking)', () => {
    // The old rule took about 4 times longer for every 2 more slashes: 28 took about 1 s, 40 about an hour.
    let started = performance.now();
    expect(POINTER.test(`${'/'.repeat(28)}~`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100); // fails fast on the old rule, before the long inputs
    started = performance.now();
    expect(call({ amount: `${'/'.repeat(199)}~` }).success).toBe(false);
    expect(call({ amount: 'a' }, { records_pointer: `${'/'.repeat(255)}~` }).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe('records_pointer', () => {
  it('refuses control and invisible characters, which every location in a finding would repeat', () => {
    expect(call({ amount: 'a' }, { records_pointer: '/data/entries' }).success).toBe(true);
    for (const bad of ['/data\u0001', '/da‮ta', '/x ']) expect(call({ amount: 'a' }, { records_pointer: bad }).success, bad).toBe(false);
  });
});
