// Limits tested at their edge, and the rarer forms of a few answers (review round 19, found by mutation:
// each of these could change by one, or lose a case, with every other test still passing). Kept apart
// from the files they belong to, which are at or near 400 lines.
import { describe, expect, it } from 'vitest';
import { overBudget } from '../src/budget.js';
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

  it('takes a .sql file of exactly 5 MiB, and refuses one byte more', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 2)}`, 'db/more/0001.sql': `--${'x'.repeat(5 * 1024 * 1024 - 1)}` });
    expect(collectSources(rootOf(dir), { migrations: 'db/migrations' }).files).toHaveLength(1);
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'db/more' }))).toMatch(/^FILE_TOO_LARGE: /);
  });
});

describe('the rarer forms of an answer', () => {
  it('writes a key with "/" or "~" as a JSON Pointer token in the records_pointer it suggests', () => {
    expect(errorText(() => check('.json', '{"a/b~c":[]}', { columns: { transaction_id: 'id', amount: 'a' } }))).toMatch(/Fix: Pass records_pointer "\/a~1b~0c", the one field there that holds an array\.$/);
  });

  it('gives the advice for code to a Python migration as to a TypeScript one', () => {
    const dir = tempDir();
    writeTree(dir, { 'mig/0001_init.py': 'pass' });
    expect(errorText(() => collectSources(rootOf(dir), { migrations: 'mig/0001_init.py' }))).toMatch(/^FILE_TYPE_NOT_ALLOWED: .* Migrations written as code \(Knex, TypeORM\) need SQL first/);
  });
});
