// Limits tested at their edge, and the rarer forms of a few answers (review round 19, found by mutation:
// each of these could change by one, or lose a case, with every other test still passing). Kept apart
// from the files they belong to, which are at or near 400 lines.
import { describe, expect, it } from 'vitest';
import { overBudget } from '../src/budget.js';
import { closest } from '../src/closest.js';
import { collectSources } from '../src/lint/files.js';
import { check } from './support/ledger.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

const errorText = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    return (err as { toText(): string }).toText();
  }
  return '';
};

describe('limits at their edge', () => {
  it('counts a result of exactly 20,000 characters as within the budget, and 20,001 as over', () => {
    const sized = (n: number) => ({ s: 'x'.repeat(n - '{"s":""}'.length) });
    expect([JSON.stringify(sized(20_000)).length, overBudget(sized(20_000)), overBudget(sized(20_001))]).toEqual([20_000, false, true]);
  });

  it('reads a JSON file of exactly 1,000,000 records, and refuses one more', () => {
    const records = (n: number) => `[${'{"t":"A","a":0},'.repeat(n - 1)}{"t":"A","a":0}]`;
    const columns = { transaction_id: 't', amount: 'a' };
    expect(errorText(() => check('.json', records(1_000_001), { columns }))).toMatch(/^TOO_MANY_ROWS: The file has more than 1,000,000 rows\./);
    expect(check('.json', records(1_000_000), { columns }).rows_read).toBe(1_000_000);
  }, 60_000);

  it('suggests a records_pointer of exactly 200 characters, and not one of 201', () => {
    const hint = (key: string) => errorText(() => check('.json', JSON.stringify({ [key]: [] }), { columns: { transaction_id: 'id', amount: 'a' } }));
    expect(hint('k'.repeat(199))).toContain(`Pass records_pointer "/${'k'.repeat(199)}", the one field there that holds an array.`);
    expect(hint('k'.repeat(200))).toMatch(/such as "\/data\/entries"\.$/);
  });

  it('reads a CSV row of exactly 10,000 fields, and refuses one of 10,001', () => {
    const row = (fields: number) => `T1,0${','.repeat(fields - 2)}`;
    const columns = { transaction_id: 'a', amount: 'b' };
    expect(errorText(() => check('.csv', `a,b\n${row(10_000)}\n`, { columns }))).not.toContain('more than 10,000 fields');
    expect(errorText(() => check('.csv', `a,b\n${row(10_001)}\n`, { columns }))).toContain('a row holds more than 10,000 fields');
  });

  it('takes a .sql file of exactly 5 MiB, and refuses one byte more', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 2)}`, 'db/more/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 1)}` });
    expect(collectSources(rootOf(dir), { migrations: 'db/migrations' }).files).toHaveLength(1);
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'db/more' }))).toMatch(/^FILE_TOO_LARGE: /);
  });
});

describe('time that grows with a name', () => {
  it('reads a header cell of 40,000 words in linear time', () => {
    // Review round 20: "valuta " × 40,000 + "date" took 19 s, each "valuta" scanning every word again.
    const started = performance.now();
    const r = check('.csv', `t,a,${'valuta '.repeat(40_000)}date\nT1,5,x\nT1,-5,y\n`, { columns: { transaction_id: 't', amount: 'a' } });
    expect(r.summary).not.toContain('looks like a currency'); // Valuta beside a date word
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('the rarer forms of an answer', () => {
  it('writes a key with "/" or "~" as a JSON Pointer token in the records_pointer it suggests', () => {
    expect(errorText(() => check('.json', '{"a/b~c":[]}', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(/Fix: Pass records_pointer "\/a~1b~0c", the one field there that holds an array\.$/);
  });

  it('says when a CSV has no header line, and warns when a mapped column is named like a value', () => {
    // Review round 20: the data cells were offered as names ("Did you mean "T1"?"), and mapped as offered,
    // the first row (T1, 999: unbalanced) was read as the header and the file came back balanced.
    const csv = 'T1,999,GBP\nT2,50,GBP\nT2,-50,GBP\n';
    const e = errorText(() => check('.csv', csv, { columns: { transaction_id: 'id', amount: 'amt' } }));
    expect(e).toContain('The first line looks like data ("999"), not a header: the first line is always read as the column names.');
    expect(e).not.toContain('Did you mean');
    expect(e).toMatch(/Fix: Add a first line that names the columns, then map each field to one of those names\.$/);
    expect(check('.csv', csv, { columns: { transaction_id: 'T1', amount: '999' } }).summary).toContain(' The mapped column "999" is named like a value: if the file has no header line, its first row was read as the column names, and was not checked.');
    expect(check('.csv', 'id,amount\nT1,5\nT1,-5\n', { columns: { transaction_id: 'id', amount: 'amount' } }).summary).not.toContain('named like a value');
  });

  it('suggests no name as far from the one asked for as its whole length', () => {
    expect([closest('id', ['1']), closest('id', ['ab']), closest('amount', ['amonut']), closest('id', ['ids'])]).toEqual([undefined, undefined, 'amonut', 'ids']);
  });

  it('suggests no records_pointer that quotes would show escaped', () => {
    // Review round 20: for the key ledger\\rows the fix showed "/ledger\\\\rows", which, passed back, led nowhere.
    for (const key of ['ledger\\rows', 'say "hi"']) {
      expect(errorText(() => check('.json', JSON.stringify({ [key]: [] }), { columns: { transaction_id: 'id', amount: 'a' } })), key).toMatch(/such as "\/data\/entries"\.$/);
    }
  });

  it('says which fields of columns clash', () => {
    const why = (columns: Record<string, string>) => errorText(() => check('.csv', 'id,a,d,c,s\nT1,1,1,1,D\n', { columns: { transaction_id: 'id', ...columns } })).replace(/^.*Here /, '').replace(/ Fix: .*$/, '');
    expect([why({ amount: 'a', debit: 'd' }), why({ amount: 'a', debit: 'd', credit: 'c' }), why({ debit: 'd' }), why({ credit: 'c' }), why({ side: 's' }), why({})]).toEqual([
      'amount cannot be mapped with debit.', 'amount cannot be mapped with debit and credit.', 'debit needs credit too.', 'credit needs debit too.', 'side goes with amount, which is not mapped.', 'none of amount, debit and credit is mapped.',
    ]);
  });

  it('gives the advice for code to a Python migration as to a TypeScript one', () => {
    const dir = tempDir();
    writeTree(dir, { 'mig/0001_init.py': 'pass' });
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'mig/0001_init.py' }))).toMatch(/^FILE_TYPE_NOT_ALLOWED: .* Migrations written as code \(Knex, TypeORM\) need SQL first/);
  });
});
