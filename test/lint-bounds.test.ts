// How much of the catalog a lint reads and passes on (SPEC.md §3.9): each long text once, and at most 50
// texts of a column, bounded in the database thread, where a migration cannot change the code. Split from
// lint-fix.test.ts, which grew past 400 lines (review round 18).
import { describe, expect, it } from 'vitest';
import { DETAIL_SQL } from '../src/lint/catalog.js';
import { lint } from './support/lint.js';
import { sql } from './support/sql.js';

describe('money_lint_schema: the texts it reads of each column', () => {
  it('reads a long unique-index condition once per index, not once per column', async () => {
    // Review round 14: 1,000 terms over 1,000 columns, read per column and per pg_depend row, ran the
    // database thread out of memory (or past 120 s with the whole row as well).
    const cols = Array.from({ length: 1000 }, (_, i) => `c${i} text`).join(', ');
    const terms = Array.from({ length: 1000 }, (_, i) => `c${i} is not null`).join(' and ');
    const schema = `create table w (${cols}, price double precision);\ncreate unique index w_u on w (c0) where ${terms} and w is not null;`;
    const r = await lint({ 'db/migrations/0001.sql': schema }, { timeout_seconds: 30 });
    expect([r.findings.length, r.findings[0]?.fix_sql]).toEqual([1, null]); // past 2,000 characters: may hold an amount
    // Each column gets the index's text once, cut to the stand-in: 1,001 columns, not 24 MB of copies.
    const rows = (await sql([schema], DETAIL_SQL)) as Array<{ index_exprs: string[] | null }>;
    const texts = rows.flatMap((row) => row.index_exprs ?? []);
    expect([texts.length, Math.max(...texts.map((t) => t.length))]).toEqual([1001, 2001]);
    // Review round 16: defaults too, each text once a column, through a chain of inheriting tables.
    const chain = [`create table c0 (price double precision default (0 + ${'0 + '.repeat(600)}0));`, ...Array.from({ length: 40 }, (_, i) => `create table c${i + 1} () inherits (c${i});`)];
    const inherited = (await sql(chain, DETAIL_SQL)) as Array<{ defaults: string[] | null }>;
    expect(inherited.map((row) => row.defaults)).toEqual([['x'.repeat(2001)]]);
  }, 60_000);

  it('reads at most 50 expressions of a column, in the database thread, past which it may hold an amount', async () => {
    // Review round 17: the SQL's cut() relies on functions a migration can replace, and distinct texts
    // through an inheritance chain still grew with its square; the worker now bounds what it sends.
    const checks = (n: number) => Array.from({ length: n }, (_, i) => `check (amount >= 0${' or amount is null'.repeat(i + 1)})`).join(', ');
    const r = await lint({ 'db/migrations/0001.sql': `create table few (amount double precision, ${checks(40)});\ncreate table many (amount double precision, ${checks(60)});` });
    expect(r.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.few', false], ['public.many', true]]);
  });

  it('reads at most 50 index texts and 50 defaults of a column too', async () => {
    // Review round 18 (found by mutation): only the CHECKs were tested. Each text here holds no amount, so
    // the fix is withheld only because the 51st and later were left out.
    const indexes = (t: string, n: number) => Array.from({ length: n }, (_, i) => `create unique index on ${t} (code) where amount is not null and code <> 'a${i}';`).join('\n');
    const r = await lint({ 'db/migrations/0001.sql': `create table few (code text, amount double precision);\ncreate table many (code text, amount double precision);\n${indexes('few', 40)}\n${indexes('many', 60)}` });
    expect(r.findings.map((f) => [f.table, f.fix_sql === null])).toEqual([['public.few', false], ['public.many', true]]);
    // Inheriting tables, each with its own zero default, written another way.
    const chain = (t: string, n: number) => [`create table ${t}0 (amount double precision default 0);`, ...Array.from({ length: n }, (_, i) => `create table ${t}${i + 1} () inherits (${t}0);\nalter table ${t}${i + 1} alter amount set default 0.${'0'.repeat(i + 1)};`)].join('\n');
    const d = await lint({ 'db/migrations/0001.sql': `${chain('few', 40)}\n${chain('many', 60)}` });
    expect(d.findings.filter((f) => f.table.endsWith('0')).map((f) => [f.table, f.fix_sql === null])).toEqual([['public.few0', false], ['public.many0', true]]);
  }, 60_000);
});

describe('money_lint_schema: defaults written short', () => {
  it('withholds fix_sql beside a default of a few characters that is not zero', async () => {
    // Review round 22 (found by mutation): only defaults of four characters or more were tested ("2.50").
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (price double precision default 5, fee numeric(10,2) default 1.5, cost double precision default 0, tip real default -1);' });
    expect(Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql === null]))).toEqual({ price: true, fee: true, cost: false, tip: true });
  });
});

describe('money_lint_schema: a result at its size limit', () => {
  it('cuts the findings, which can be paged, before the float columns, and says how many floats are listed', async () => {
    // Review round 22: the floats, which no parameter pages through, were cut first, and the summary still
    // said "the first 30 listed" over 12.
    // Names at PostgreSQL's 63-byte limit, so 50 findings pass the budget.
    const tables = Array.from({ length: 55 }, (_, i) => `create table customer_subscription_invoice_line_item_with_a_long_name_${String(i).padStart(3, '0')} (unit_price_amount_in_the_billing_currency_of_the_customer_account double precision, latitude_measurement_of_the_delivery_point_for_this_line_item double precision);`);
    const r = await lint({ 'db/migrations/0001.sql': tables.join('\n') });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect([r.findings.length < 50, r.next_offset === r.findings.length, r.other_float_columns.length]).toEqual([true, true, 30]);
    expect(r.summary).toContain(`55 other float columns (other_float_columns, the first ${r.other_float_columns.length} listed)`);
  });
});

describe('money_lint_schema: float columns cut to fit', () => {
  it('says how many are listed when even one finding leaves no room for all 30', async () => {
    // Control characters show as six-character escapes, so 35 names of 63 bytes fill the result.
    const c = '\u{1}'.repeat(58);
    const sql = [`create schema "s${c}";`, ...Array.from({ length: 35 }, (_, i) => `create table "s${c}"."t${String(i).padStart(2, '0')}${c}" ("lat${c}" double precision);`), 'create table p (price double precision);'];
    const r = await lint({ 'db/migrations/0001.sql': sql.join('\n') });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect([r.findings.length, r.other_float_columns.length < 30]).toEqual([1, true]);
    expect(r.summary).toContain(`35 other float columns (other_float_columns, the first ${r.other_float_columns.length} listed)`);
  });
});
