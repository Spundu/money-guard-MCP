// The input schemas run on every call, before any handler, so they must be cheap on hostile input.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_SECONDS } from '../src/lint/run.js';
import { POINTER, ledgerInput, lintInput } from '../src/schemas.js';

const call = (columns: Record<string, string>, extra: Record<string, unknown> = {}) =>
  ledgerInput.safeParse({ file: 'exports/ledger.json', columns: { transaction_id: 'id', ...columns }, ...extra });

describe('the JSON Pointer rule', () => {
  it('accepts RFC 6901 pointers and refuses the rest', () => {
    for (const ok of ['', '/', '/data/entries', '/a~0b/~1c', '//', '/a//b', `/${'x'.repeat(300)}`]) expect(POINTER.test(ok), ok).toBe(true);
    for (const bad of ['a', 'data/entries', '/a~2', '/a~', '/~']) expect(POINTER.test(bad), bad).toBe(false);
  });

  it('answers at once on a long run of slashes that cannot match (no catastrophic backtracking)', () => {
    // The old rule took about 4 times longer for every 2 more slashes: 28 took about 1 s, 32 about 16 s,
    // 40 about an hour. The bounds leave a wide margin for a loaded machine.
    let started = performance.now();
    expect(POINTER.test(`${'/'.repeat(32)}~`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000); // fails on the old rule before the long inputs
    started = performance.now();
    expect(call({ amount: `${'/'.repeat(199)}~` }).success).toBe(false);
    expect(call({ amount: 'a' }, { records_pointer: `${'/'.repeat(255)}~` }).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('records_pointer', () => {
  it('refuses control and invisible characters, which every location in a finding would repeat', () => {
    expect(call({ amount: 'a' }, { records_pointer: '/data/entries' }).success).toBe(true);
    for (const bad of ['/data\u0001', '/da\u202eta', '/x\u2028']) expect(call({ amount: 'a' }, { records_pointer: bad }).success, bad).toBe(false);
  });
});

describe('files', () => {
  it('refuses an empty list: leave files out to run the whole folder', () => {
    expect(lintInput.safeParse({ migrations: 'db/migrations', files: [] }).success).toBe(false);
    expect(lintInput.safeParse({ migrations: 'db/migrations', files: ['0001.sql'] }).success).toBe(true);
  });
});

describe('timeout_seconds', () => {
  it('defaults to 45 seconds, under the 60 that common MCP clients wait for an answer, and says so', () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(45);
    expect(lintInput.shape.timeout_seconds.description).toBe('Stop after this many seconds. Default 45: most clients wait at most 60 for an answer.');
  });
});
