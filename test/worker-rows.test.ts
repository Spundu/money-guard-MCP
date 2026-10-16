// Review round 19: the checks the database thread makes on the rows a replaced function can make huge
// (round 18) were tested only with a megabyte of "x", which every check refuses. Each limit here is
// tested at its edge, with the numbers written out, so that changing one fails a test.
import { describe, expect, it } from 'vitest';
import { bounded, saneSnapshot } from '../src/lint/worker-rows.js';

describe('saneSnapshot', () => {
  it('passes the rows PostgreSQL gives: a column key and a type oid or "float"', () => {
    expect(saneSnapshot([['16385:1', 'float'], ['16385:2', '1700'], ['4294967295:32767', '1234567890']])).toBe(true);
    expect(saneSnapshot([])).toBe(true);
  });

  it('refuses a column key with anything before or after it', () => {
    expect([saneSnapshot([['x16385:1', 'float']]), saneSnapshot([['16385:1x', 'float']]), saneSnapshot([[`16385:1${'x'.repeat(1_000_000)}`, 'float']])]).toEqual([false, false, false]);
    expect([saneSnapshot([['12345678901:1', 'float']]), saneSnapshot([['16385:123456', 'float']])]).toEqual([false, false]); // longer than an oid or a column number
  });

  it('refuses a type that is neither an oid nor "float", with the column key sound', () => {
    expect([saneSnapshot([['16385:1', 'numeric']]), saneSnapshot([['16385:1', 'x'.repeat(100)]]), saneSnapshot([['16385:1', null]]), saneSnapshot([['16385:1', '12345678901']])]).toEqual([false, false, false, false]);
  });
});

describe('bounded', () => {
  const row = (extra: Record<string, unknown> = {}) => ({ col: '16385:1', schema_name: 'public', table_name: 't', column_name: 'price', declared: 'numeric', domain_name: null, defaults: null, checks: null, index_exprs: null, ...extra });

  it('passes sound rows on unchanged', () => {
    expect(bounded([row({ defaults: ['0'], checks: ['(price > 0)'], index_exprs: [] })])).toEqual([row({ defaults: ['0'], checks: ['(price > 0)'], index_exprs: [] })]);
  });

  it('refuses every row when one has a column key PostgreSQL never gives', () => {
    expect(bounded([row(), row({ col: 'x16385:1' })])).toEqual([null]);
    expect(bounded([row({ col: 16385 })])).toEqual([null]);
  });

  it('refuses names past 512 characters, and cuts a type text to 512', () => {
    expect(bounded([row({ table_name: 'x'.repeat(512) })])).toEqual([row({ table_name: 'x'.repeat(512) })]);
    expect(bounded([row({ table_name: 'x'.repeat(513) })])).toEqual([null]);
    expect(bounded([row({ column_name: 'x'.repeat(513) })])).toEqual([null]);
    expect(bounded([row({ declared: 'x'.repeat(600), domain_name: 'y'.repeat(513) })])).toEqual([row({ declared: 'x'.repeat(512), domain_name: 'y'.repeat(512) })]);
  });

  it('keeps a text of 2,000 characters and puts one stand-in for those over it', () => {
    const [kept] = bounded([row({ defaults: ['x'.repeat(2000)], checks: ['c'.repeat(2000)] })]) as Array<Record<string, unknown>>;
    expect([kept?.defaults, kept?.checks]).toEqual([['x'.repeat(2000)], ['c'.repeat(2000)]]);
    const [cut] = bounded([row({ defaults: ['0', 'x'.repeat(2001), 'y'.repeat(2001)], checks: ['c'.repeat(2001)], index_exprs: ['i'.repeat(2001)] })]) as Array<Record<string, unknown>>;
    expect([cut?.defaults, cut?.checks, cut?.index_exprs]).toEqual([['0', 'x'.repeat(2001)], [null], [null]]); // the defaults' stand-in is a text over 2,000
  });

  it('keeps 50 texts of a column and puts one stand-in for the 51st on', () => {
    const texts = (n: number) => Array.from({ length: n }, (_, i) => `(price > ${i})`);
    const [fifty] = bounded([row({ checks: texts(50) })]) as Array<Record<string, unknown>>;
    expect(fifty?.checks).toEqual(texts(50));
    const [more] = bounded([row({ checks: texts(52) })]) as Array<Record<string, unknown>>;
    expect(more?.checks).toEqual([...texts(50), null]);
  });

  it('stops at 1,000,000 characters of texts in all', () => {
    const rows = Array.from({ length: 501 }, (_, i) => row({ col: `16385:${i + 1}`, defaults: ['x'.repeat(1999)] }));
    rows.push(row({ col: '16385:600', defaults: ['x'.repeat(500)] })); // 501 × 1,999 = 1,001,499: the 501st does not fit
    const out = bounded(rows) as Array<Record<string, unknown>>;
    expect(out.slice(0, 500).every((r) => (r.defaults as string[])[0] === 'x'.repeat(1999))).toBe(true);
    expect(out[500]?.defaults).toEqual(['x'.repeat(2001)]);
    expect(out[501]?.defaults).toEqual(['x'.repeat(500)]); // 500 characters were left
  });

  it('passes on a value that is not text, for the main thread to refuse', () => {
    expect(bounded([row({ defaults: 'not an array', checks: [7] })])).toEqual([row({ defaults: 'not an array', checks: [7] })]);
  });
});
