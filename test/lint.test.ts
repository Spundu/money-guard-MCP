// money_lint_schema (SPEC.md §3): the documented example, and how each column is judged and fixed.
// test/lint-files.test.ts covers which files run, links, failures, platforms and safety.
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { NULL_FIX_NOTE } from '../src/lint/catalog.js';
import { SPEC_FILES, codeOf, failure, lastDir, lint } from './support/lint.js';

describe('money_lint_schema: the SPEC.md §3.10 example', () => {
  it('gives exactly the documented result', async () => {
    const r = await lint(SPEC_FILES);
    const dir = lastDir();
    const hash = createHash('sha256');
    for (const [rel, text] of Object.entries(SPEC_FILES)) hash.update(`${dir}/${rel}`).update('\0').update(text);
    expect(r).toEqual({
      summary: '2 problems in 2 money columns (1 error, 1 warning). 3 migration files applied.',
      migrations: `${dir}/db/migrations`,
      migrations_sha256: hash.digest('hex'),
      postgres: 'PostgreSQL 18.6 (PGlite 0.5.9)',
      files_applied_count: 3,
      files_applied: Object.keys(SPEC_FILES).map((rel) => `${dir}/${rel}`),
      files_applied_truncated: false,
      tables_checked: 2,
      money_columns_checked: 4,
      error_count: 1,
      warning_count: 1,
      ignored_count: 0,
      findings: [
        {
          code: 'FLOAT_MONEY',
          severity: 'error',
          table: 'public.orders',
          column: 'total',
          type: 'double precision',
          introduced_in: `${dir}/db/migrations/0001_init.sql`,
          fix_sql: 'ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;',
        },
        {
          code: 'NUMERIC_MONEY',
          severity: 'warning',
          table: 'public.orders',
          column: 'platform_fee',
          type: 'numeric(10,2)',
          introduced_in: `${dir}/db/migrations/0002_fees.sql`,
          fix_sql: 'ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING round(platform_fee * 100)::bigint;',
        },
      ],
      findings_truncated: false,
      other_float_columns: [],
      other_float_columns_count: 0,
      fixes: {
        FLOAT_MONEY: expect.stringMatching(/^real and double precision are binary floating point/),
        NUMERIC_MONEY: expect.stringMatching(/^numeric is exact/),
      },
    });
  });

  it('is clean once a NEW migration applies the fix it suggests (the fix itself is run)', async () => {
    const r = await lint({
      ...SPEC_FILES,
      'db/migrations/0004_fix.sql':
        'ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING round(total * 100)::bigint;\n' +
        'ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING round(platform_fee * 100)::bigint;\n',
    });
    expect(r.findings).toEqual([]);
    expect(r.summary).toBe('No problems: 4 money columns in 2 tables use safe types. 4 migration files applied.');
  });
});

describe('money_lint_schema: judging columns', () => {
  it('handles every kind of column in one schema (domains, arrays, money, smallint, generated, quoting, partitions, inheritance, views)', async () => {
    const r = await lint({
      'db/migrations/0001.sql': [
        'create domain pence as bigint check (value >= 0);',
        'create domain amount_f as double precision;',
        'create domain amount_ff as amount_f;',
        'create table shop (',
        '  id int primary key,',
        '  price_ok pence,',
        '  price_dom amount_ff,',
        '  prices double precision[],',
        '  refund money,',
        '  plain_label money,',
        '  fee smallint,',
        '  amount_pence real,',
        '  gross double precision,',
        '  total double precision generated always as (gross * 2) stored,',
        '  lat double precision,',
        '  tax_rate double precision',
        ');',
        'create table "Orders" ("TotalPrice" double precision);',
        'create table sales (amount numeric, sold_on date not null) partition by range (sold_on);',
        "create table sales_2026 partition of sales for values from ('2026-01-01') to ('2027-01-01');",
        'create table base_fees (fee double precision);',
        'create table child_fees (note text) inherits (base_fees);',
        'create view v_shop as select prices, refund from shop;',
      ].join('\n'),
    });
    const brief = r.findings.map((f) => [f.code, `${f.table}.${f.column}`, f.type, f.fix_sql]);
    expect(brief).toEqual([
      ['FLOAT_MONEY', 'public.Orders.TotalPrice', 'double precision', 'ALTER TABLE public."Orders" ALTER COLUMN "TotalPrice" TYPE bigint USING round("TotalPrice" * 100)::bigint;'],
      ['FLOAT_MONEY', 'public.base_fees.fee', 'double precision', 'ALTER TABLE public.base_fees ALTER COLUMN fee TYPE bigint USING round(fee * 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.amount_pence', 'real', 'ALTER TABLE public.shop ALTER COLUMN amount_pence TYPE bigint USING round(amount_pence)::bigint;'],
      ['MONEY_TYPE', 'public.shop.plain_label', 'money', 'ALTER TABLE public.shop ALTER COLUMN plain_label TYPE bigint USING (plain_label::numeric * 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.price_dom', 'amount_ff (double precision)', null],
      ['FLOAT_MONEY', 'public.shop.prices', 'double precision[]', null],
      ['MONEY_TYPE', 'public.shop.refund', 'money', 'ALTER TABLE public.shop ALTER COLUMN refund TYPE bigint USING (refund::numeric * 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.total', 'double precision', null],
      ['NUMERIC_MONEY', 'public.sales.amount', 'numeric', 'ALTER TABLE public.sales ALTER COLUMN amount TYPE bigint USING round(amount * 100)::bigint;'],
      ['SMALLINT_MONEY', 'public.shop.fee', 'smallint', 'ALTER TABLE public.shop ALTER COLUMN fee TYPE bigint;'],
    ]);
    // gross is not money-named; lat and tax_rate are not money: listed for the model to look at.
    expect(r.other_float_columns).toEqual(['public.shop.gross', 'public.shop.lat', 'public.shop.tax_rate']);
    expect(r.tables_checked).toBe(5); // shop, Orders, sales (not its partition), base_fees, child_fees; not the view
  });

  it('keeps track of a column through renames, and dates a finding from the last type change', async () => {
    const r = await lint({
      'db/migrations/0001_init.sql': 'create table orders (total double precision, fee numeric(10,2));',
      'db/migrations/0002_rename.sql': 'alter table orders rename to purchases; alter table purchases rename column total to grand_total;',
      'db/migrations/0003_fee_float.sql': 'alter table purchases alter column fee type double precision;',
    });
    expect(r.findings.map((f) => [f.column, f.introduced_in.split('/').at(-1)])).toEqual([
      ['fee', '0003_fee_float.sql'],
      ['grand_total', '0001_init.sql'],
    ]);
  });

  it('treats listed columns as money, skips ignored ones and counts them', async () => {
    const files = { 'db/migrations/0001.sql': 'create table orders (grand double precision, cost_center_total double precision);' };
    const r = await lint(files, { money_columns: ['orders.grand'], ignore_columns: ['public.orders.cost_center_total'] });
    expect(r.findings.map((f) => f.column)).toEqual(['grand']);
    expect(r.ignored_count).toBe(1);
    expect(r.summary).toBe('1 problem in 1 money column (1 error, 0 warnings). 1 migration file applied. 1 ignored.');
  });

  it('accepts numeric money columns when told to', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (price numeric(12,2));' }, { accept_numeric: true });
    expect(r.findings).toEqual([]);
    expect(r.money_columns_checked).toBe(1);
  });

  it('says so when no column looks like money, pointing at the float columns', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table places (lat double precision, lng double precision);' });
    expect(r.summary).toBe('No money columns found in 1 table; 2 float columns in other_float_columns, in case one holds money. 1 migration file applied.');
  });

  it('refuses a badly written column list', async () => {
    expect(await codeOf(SPEC_FILES, { money_columns: ['orders'] })).toBe('BAD_COLUMN_NAME');
    expect(await codeOf(SPEC_FILES, { ignore_columns: ['a.b.c.d'] })).toBe('BAD_COLUMN_NAME');
  });

  it('gives a fix_sql that converts the stored amounts correctly, and none where the unit needs a decision', async () => {
    const r = await lint({
      'db/migrations/0001.sql':
        'create table p (price double precision, amount_minor_units double precision, price_cents_usd double precision, ' +
        'fee numeric(10,2), total numeric, amount numeric(12,0), unit_price numeric(12,4), amount_pence numeric(10,2));',
    });
    const fix = Object.fromEntries(r.findings.map((f) => [f.column, f.fix_sql]));
    expect([fix.unit_price, fix.amount_pence]).toEqual([null, null]); // finer than a penny: choose the unit first
    expect(r.fixes.NUMERIC_MONEY).toContain(NULL_FIX_NOTE.trim());
    expect(r.fixes.FLOAT_MONEY).not.toContain('Where fix_sql is null');
    // Run each fix on real rows: pounds become pence, minor units and whole numbers stay as they are.
    const db = await PGlite.create();
    try {
      await db.exec(
        'create table p (price double precision, amount_minor_units double precision, price_cents_usd double precision, fee numeric(10,2), total numeric, amount numeric(12,0));' +
          'insert into p values (19.99, 1999, 1999, 12.34, 0.1, 1500);',
      );
      const columns = ['price', 'amount_minor_units', 'price_cents_usd', 'fee', 'total', 'amount'];
      for (const column of columns) await db.exec(fix[column] ?? 'fix_sql missing');
      const row = (await db.query<Record<string, string>>(`select ${columns.map((c) => `${c}::text`).join(', ')} from p`)).rows[0];
      expect(row).toEqual({ price: '1999', amount_minor_units: '1999', price_cents_usd: '1999', fee: '1234', total: '10', amount: '1500' });
    } finally {
      await db.close();
    }
  });

  it('checks and counts a column of the money type whatever its name', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table shipments (freight money);' });
    expect([r.money_columns_checked, r.findings.map((f) => [f.code, f.column])]).toEqual([1, [['MONEY_TYPE', 'freight']]]);
  });

  it('counts as checked only money columns of a number type, and says how many it could not check', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create type monetary as (amount double precision); create table t (price bigint, total jsonb, balance text, fee monetary);' });
    expect(r.money_columns_checked).toBe(1);
    expect(r.summary).toBe('No problems: 1 money column in 1 table uses a safe type. 1 migration file applied. 3 money-named columns of text, JSON or another type were not checked.');
  });

  it('refuses a money_columns or ignore_columns entry that names no column, and suggests the real one', async () => {
    const files = { 'db/migrations/0001.sql': 'create table orders (grossvalue numeric(10,2), amount numeric(10,2));' };
    expect((await failure(files, { money_columns: ['Orders.GrossValue'] })).toText()).toMatch(
      /^BAD_COLUMN_NAME: money_columns names "public\.Orders\.GrossValue", which is not a column of any table the migrations create\. Did you mean "public\.orders\.grossvalue"\?/,
    );
    expect(await codeOf(files, { ignore_columns: ['orders.amount', 'orders.nothing_like_it'] })).toBe('BAD_COLUMN_NAME');
  });

  it('dates a finding from when the column got its type, not from a later change of precision', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (fee numeric(10,2));', 'db/migrations/0002.sql': 'alter table t alter column fee type numeric(12,2);' });
    expect(r.findings.map((f) => f.introduced_in.split('/').at(-1))).toEqual(['0001.sql']);
  });

  it('caps the findings at 50 and the lists at 30, and counts them all', async () => {
    const columns = Array.from({ length: 60 }, (_, i) => `price_${i} double precision`).join(', ');
    const files: Record<string, string> = { 'db/migrations/0000.sql': `create table big (${columns});` };
    for (let i = 1; i <= 34; i += 1) files[`db/migrations/${String(i).padStart(4, '0')}.sql`] = 'select 1;';
    const r = await lint(files);
    expect([r.findings.length, r.findings_truncated, r.error_count]).toEqual([50, true, 60]);
    expect([r.files_applied.length, r.files_applied_truncated, r.files_applied_count]).toEqual([30, true, 35]);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
  });

  it('stays within 20,000 characters with the longest names and a deep folder, cutting the file list first', async () => {
    // 63 characters is PostgreSQL's longest name. 50 such findings in a deep folder come to about
    // 32,000 characters.
    const columns = Array.from({ length: 60 }, (_, i) => `price_${String(i).padStart(2, '0')}_${'x'.repeat(54)} double precision`);
    const r = await lint({ [`db/migrations/${'d'.repeat(100)}/0001.sql`]: `create table t_${'y'.repeat(61)} (${columns.join(', ')});` });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect([r.files_applied, r.files_applied_truncated, r.files_applied_count]).toEqual([[], true, 1]);
    expect(r.findings.length).toBeGreaterThan(20);
    expect(r.findings.length).toBeLessThan(50);
    expect([r.findings_truncated, r.error_count]).toEqual([true, 60]);
    expect(r.findings[0]?.column).toBe(`price_00_${'x'.repeat(54)}`);
  });
});
