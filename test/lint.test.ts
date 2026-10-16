// money_lint_schema (SPEC.md §3): the documented example, and how each column is judged. fix_sql is in
// lint-fix.test.ts; lint-files.test.ts and lint-failures.test.ts cover which files run, links,
// failures, platforms and safety.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
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
          fix_sql: 'ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;',
        },
        {
          code: 'NUMERIC_MONEY',
          severity: 'warning',
          table: 'public.orders',
          column: 'platform_fee',
          type: 'numeric(10,2)',
          introduced_in: `${dir}/db/migrations/0002_fees.sql`,
          fix_sql: 'ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING pg_catalog.round(platform_fee OPERATOR(pg_catalog.*) 100)::bigint;',
        },
      ],
      findings_truncated: false,
      next_offset: null,
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
        'ALTER TABLE public.orders ALTER COLUMN total TYPE bigint USING pg_catalog.round(total OPERATOR(pg_catalog.*) 100)::bigint;\n' +
        'ALTER TABLE public.orders ALTER COLUMN platform_fee TYPE bigint USING pg_catalog.round(platform_fee OPERATOR(pg_catalog.*) 100)::bigint;\n',
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
        '  base double precision,',
        '  total double precision generated always as (base * 2) stored,',
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
      ['FLOAT_MONEY', 'public.Orders.TotalPrice', 'double precision', 'ALTER TABLE public."Orders" ALTER COLUMN "TotalPrice" TYPE bigint USING pg_catalog.round("TotalPrice" OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['FLOAT_MONEY', 'public.base_fees.fee', 'double precision', 'ALTER TABLE public.base_fees ALTER COLUMN fee TYPE bigint USING pg_catalog.round(fee OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.amount_pence', 'real', 'ALTER TABLE public.shop ALTER COLUMN amount_pence TYPE bigint USING pg_catalog.round(amount_pence)::bigint;'],
      ['MONEY_TYPE', 'public.shop.plain_label', 'money', 'ALTER TABLE public.shop ALTER COLUMN plain_label TYPE bigint USING (plain_label::numeric OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.price_dom', 'public.amount_ff (double precision)', null],
      ['FLOAT_MONEY', 'public.shop.prices', 'double precision[]', null],
      ['MONEY_TYPE', 'public.shop.refund', 'money', 'ALTER TABLE public.shop ALTER COLUMN refund TYPE bigint USING (refund::numeric OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['FLOAT_MONEY', 'public.shop.total', 'double precision', null],
      ['NUMERIC_MONEY', 'public.sales.amount', 'numeric', 'ALTER TABLE public.sales ALTER COLUMN amount TYPE bigint USING pg_catalog.round(amount OPERATOR(pg_catalog.*) 100)::bigint;'],
      ['SMALLINT_MONEY', 'public.shop.fee', 'smallint', 'ALTER TABLE public.shop ALTER COLUMN fee TYPE bigint;'],
    ]);
    // base is not money-named; lat and tax_rate are not money: listed for the model to look at.
    expect(r.other_float_columns).toEqual(['public.shop.base', 'public.shop.lat', 'public.shop.tax_rate']);
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

  it('reads the catalog with PostgreSQL\'s own operators, and gives each migration the search_path the last one left', async () => {
    // Review round 19: a public.= put first on search_path made the lint say no tables existed.
    const r = await lint({
      'db/migrations/0001.sql': 'create table orders (price double precision);',
      'db/migrations/0002.sql': [
        'create function public.never(a "char", b "char") returns boolean language sql immutable as \'select false\';',
        'create operator public.= (leftarg = "char", rightarg = "char", function = public.never);',
        'create schema app;',
        'set search_path = app, public, pg_catalog;',
      ].join('\n'),
      'db/migrations/0003.sql': 'create table later (total real);', // created in app, as the setting says
    });
    expect(r.findings.map((f) => `${f.table}.${f.column}`).sort()).toEqual(['app.later.total', 'public.orders.price']);
  });

  it('treats listed columns as money, skips ignored ones and counts them', async () => {
    // fee_pence is bigint, so ignoring it hides no finding: ignored_count counts findings, not columns.
    const files = { 'db/migrations/0001.sql': 'create table orders (grand double precision, cost_center_total double precision, fee_pence bigint);' };
    const r = await lint(files, { money_columns: ['orders.grand'], ignore_columns: ['public.orders.cost_center_total', 'orders.fee_pence'] });
    expect(r.findings.map((f) => f.column)).toEqual(['grand']);
    expect(r.ignored_count).toBe(1);
    expect(r.summary).toBe('1 problem in 1 money column (1 error, 0 warnings). 1 migration file applied. 1 ignored.');
  });

  it('accepts numeric money columns when told to', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (price numeric(12,2));' }, { accept_numeric: true });
    expect(r.findings).toEqual([]);
    expect(r.money_columns_checked).toBe(1);
    // Review round 17 (found by mutation): only numeric; smallint, money and floats are still reported.
    const mixed = await lint({ 'db/migrations/0001.sql': 'create table m (price numeric(12,2), fee smallint, total money, tax real);' }, { accept_numeric: true });
    expect(mixed.findings.map((f) => [f.column, f.code])).toEqual([['tax', 'FLOAT_MONEY'], ['total', 'MONEY_TYPE'], ['fee', 'SMALLINT_MONEY']]);
  });

  it('says so when no column looks like money, pointing at the float columns', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table places (lat double precision, lng double precision);' });
    expect(r.summary).toBe('No money columns found in 1 table. 1 migration file applied. 2 float columns (other_float_columns): check that none holds money.');
  });

  it('does not say no money column was found when one was ignored, or held as text', async () => {
    const ignored = await lint({ 'db/migrations/0001.sql': 'create table o (total double precision);' }, { ignore_columns: ['o.total'] });
    expect(ignored.summary).toBe('No money columns left to check in 1 table. 1 migration file applied. 1 ignored.');
    // A money column of a safe type, ignored, is left out too: none is "found" (review round 6).
    const safe = await lint({ 'db/migrations/0001.sql': 'create table o (amount_pence bigint);' }, { ignore_columns: ['o.amount_pence'] });
    expect(safe.summary).toBe('No money columns left to check in 1 table. 1 migration file applied.');
    // Review round 7: so is a column of the money type, whatever its name.
    const typed = await lint({ 'db/migrations/0001.sql': 'create table o (x money);' }, { ignore_columns: ['o.x'] });
    expect(typed.summary).toBe('No money columns left to check in 1 table. 1 migration file applied. 1 ignored.');
    const text = await lint({ 'db/migrations/0001.sql': 'create table o (total text);' });
    expect(text.summary).toBe('No money columns of a number type found in 1 table. 1 migration file applied. 1 money-named column of text, JSON or another type was not checked.');
  });

  it('refuses a badly written column list', async () => {
    expect(await codeOf(SPEC_FILES, { money_columns: ['orders'] })).toBe('BAD_COLUMN_NAME');
    expect(await codeOf(SPEC_FILES, { ignore_columns: ['a.b.c.d'] })).toBe('BAD_COLUMN_NAME');
  });

  it('checks and counts a column of the money type whatever its name', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table shipments (freight money);' });
    expect([r.money_columns_checked, r.findings.map((f) => [f.code, f.column])]).toEqual([1, [['MONEY_TYPE', 'freight']]]);
  });

  it('says in every summary when float columns not taken for money exist, and counts only tables with money columns', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table orders (total bigint, weight real); create table notes (id int); create table tags (id int);' });
    expect(r.summary).toBe('No problems: 1 money column in 1 table uses a safe type. 1 migration file applied. 1 other float column (other_float_columns): check that none holds money.');
    const bad = await lint({ 'db/migrations/0001.sql': 'create table orders (total double precision, lat double precision, lng double precision);' });
    expect(bad.summary).toBe('1 problem in 1 money column (1 error, 0 warnings). 1 migration file applied. 2 other float columns (other_float_columns): check that none holds money.');
  });

  it('counts as checked only money columns of a number type, and says how many it could not check', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create type monetary as (amount double precision); create table t (price bigint, total jsonb, balance text, fee monetary);' });
    expect(r.money_columns_checked).toBe(1);
    expect(r.summary).toBe('No problems: 1 money column in 1 table uses a safe type. 1 migration file applied. 3 money-named columns of text, JSON or another type were not checked.');
  });

  it('refuses a money_columns or ignore_columns entry that names no column, and suggests the real one', async () => {
    const files = { 'db/migrations/0001.sql': 'create table orders (grossvalue numeric(10,2), amount numeric(10,2));' };
    expect((await failure(files, { money_columns: ['Orders.GrossValue'] })).toText()).toMatch(
      /^BAD_COLUMN_NAME: money_columns names "Orders\.GrossValue", which is not a column of any table the migrations create\. Did you mean "public\.orders\.grossvalue"\?/,
    );
    expect(await codeOf(files, { ignore_columns: ['orders.amount', 'orders.nothing_like_it'] })).toBe('BAD_COLUMN_NAME');
    // Review round 17: a name with a backslash, copied doubled from a result, is told to write it once.
    const slash = await failure({ 'db/migrations/0001.sql': 'create table t ("wid\\get" double precision);' }, { money_columns: ['t.wid\\\\get'] });
    expect(slash.fix).toMatch(/ Write each backslash once: results show it doubled\.$/);
    expect((await failure(files, { money_columns: ['orders.grossvalu'] })).fix).not.toContain('backslash');
  });

  it('keeps long names whole in the suggestion, and counts an ignored numeric money column', async () => {
    // Review round 8: database names stay whole, the suggestion too (up to 191 characters).
    const [s, t] = ['s'.repeat(60), 't'.repeat(60)];
    const long = { 'db/migrations/0001.sql': `create schema ${s}; create table ${s}.${t} (price_total numeric(10,2));` };
    expect((await failure(long, { money_columns: [`${s}.${t}.price_totl`] })).message).toContain(`Did you mean "${s}.${t}.price_total"?`);
    // Review round 11: an ignored numeric money column is counted, with accept_numeric left out.
    const ignoredNumeric = await lint({ 'db/migrations/0001.sql': 'create table orders (price numeric(10,2), fee numeric(10,2));' }, { ignore_columns: ['orders.fee'] });
    expect([ignoredNumeric.ignored_count, ignoredNumeric.summary.endsWith('1 ignored.')]).toEqual([1, true]);
  });

  it('suggests the column for an entry as written, in any case, and tells a table from a column', async () => {
    // Review round 14: split from the test above, whose 13 lints passed 60 s on a busy machine.
    const files = { 'db/migrations/0001.sql': 'create table orders (grossvalue numeric(10,2), amount numeric(10,2));' };
    const t = 't'.repeat(60);
    // Review round 11: the entry as written, and a table named instead of a column is told so.
    // Review round 12: a column name that starts like another is not "a table".
    expect((await failure(files, { ignore_columns: ['public.orders.grossvalu'] })).message).toContain('Did you mean "public.orders.grossvalue"?');
    expect((await failure(files, { ignore_columns: ['public.orders'] })).message).toBe('ignore_columns names "public.orders", which is not a column of any table the migrations create. That is a table: name one of its columns.');
    // Review round 10: within a long-named table, the column names are compared, not the first 64 characters.
    const wide = { 'db/migrations/0001.sql': `create table ${t} (amount_aaa_refunded numeric(10,2), amount_zzz numeric(10,2));` };
    expect((await failure(wide, { ignore_columns: [`${t}.amount_zzx`] })).message).toContain(`Did you mean "public.${t}.amount_zzz"?`);
    // Review round 11: the table compared in any case, and a mistyped table still gets the whole name.
    expect((await failure(wide, { ignore_columns: [`${t.toUpperCase()}.amount_zzx`] })).message).toContain(`Did you mean "public.${t}.amount_zzz"?`);
    expect((await failure(files, { money_columns: ['order.grossvalue'] })).message).toContain('Did you mean "public.orders.grossvalue"?');
    // Review round 9: a quote in a name is escaped in quotes, the entry's and the suggestion's alike.
    const quote = await failure({ 'db/migrations/0001.sql': 'create table t ("pri""ce" numeric(10,2));' }, { money_columns: ['t.pri"cee'] });
    expect(quote.message).toBe('money_columns names "t.pri\\"cee", which is not a column of any table the migrations create. Did you mean "public.t.pri\\"ce"?');
    // A column alone could be in any table: the entry must name one.
    expect((await failure(files, { money_columns: ['grossvalue'] })).message).toBe('money_columns entry "grossvalue" is not "table.column" or "schema.table.column".');
  });

  it('dates a finding from when the column got its type, not from a later change of precision', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (fee numeric(10,2));', 'db/migrations/0002.sql': 'alter table t alter column fee type numeric(12,2);' });
    expect(r.findings.map((f) => f.introduced_in.split('/').at(-1))).toEqual(['0001.sql']);
    // real to double precision is a change of float precision too: the float came in 0001.
    const floats = await lint({ 'db/migrations/0001.sql': 'create table t (price real);', 'db/migrations/0002.sql': 'alter table t alter column price type double precision;' });
    expect(floats.findings.map((f) => [f.type, f.introduced_in.split('/').at(-1)])).toEqual([['double precision', '0001.sql']]);
  });

  it('refuses a money_columns entry for a column setup creates, and says how to name an inherited column', async () => {
    const setup = await failure({ 'setup.sql': 'create table platform (fee double precision);', 'db/migrations/0001.sql': 'create table t (total bigint);' }, { setup: 'setup.sql', money_columns: ['platform.fee'] });
    expect(setup.toText()).toMatch(/^BAD_COLUMN_NAME: money_columns names "platform\.fee", a column that setup or the preset creates: only columns the migrations create or change are checked\./);
    const inherited = await failure({ 'db/migrations/0001.sql': 'create table fees (fee bigint); create table child_fees (note text) inherits (fees);' }, { money_columns: ['child_fees.fee'] });
    expect(inherited.fix).toMatch(/Name an inherited column by the table that defines it/);
  });

  it('counts as "not checked" only money-named columns that can hold an amount: text, JSON, composites; not booleans or dates', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create table t (total bigint, tax_exempt boolean, price_valid_until timestamptz, refund_ids uuid[], balance_note_total text);' });
    expect(r.summary).toBe('No problems: 1 money column in 1 table uses a safe type. 1 migration file applied. 1 money-named column of text, JSON or another type was not checked.');
    // varchar, char and an extension's text type (citext) can hold an amount too.
    const more = await lint({ 'db/migrations/0001.sql': 'create extension citext; create table t (price_str varchar(20), amount_char char(10), balance_ci citext);' });
    expect(more.summary).toBe('No money columns of a number type found in 1 table. 1 migration file applied. 3 money-named columns of text, JSON or another type were not checked.');
  });

  it('caps the findings at 50 and the lists at 30, and counts them all', async () => {
    const floats = Array.from({ length: 32 }, (_, i) => `lat_${i} double precision`);
    const columns = [...Array.from({ length: 60 }, (_, i) => `price_${i} double precision`), ...floats].join(', ');
    const files: Record<string, string> = { 'db/migrations/0000.sql': `create table big (${columns});` };
    for (let i = 1; i <= 34; i += 1) files[`db/migrations/${String(i).padStart(4, '0')}.sql`] = 'select 1;';
    const r = await lint(files);
    expect([r.findings.length, r.findings_truncated, r.error_count, r.next_offset]).toEqual([50, true, 60, 50]);
    // Review round 11: the next page, and the last; together they hold every finding once.
    const second = await lint(files, { offset: 50 });
    expect([second.findings.length, second.findings_truncated, second.next_offset]).toEqual([10, true, null]);
    expect(new Set([...r.findings, ...second.findings].map((f) => f.column)).size).toBe(60);
    // Review round 12: the last page says which findings these are, not to pass a next_offset that is null.
    expect(second.summary).toMatch(/ These are findings 51-60 of 60, the last\.$/);
    expect((await lint(files, { offset: 999 })).summary).toMatch(/ No findings from offset 999: there are 60\.$/);
    expect((await lint(files, { offset: 59 })).summary).toMatch(/ This is finding 60 of 60, the last\.$/); // round 13
    const three = await lint({ 'db/migrations/0001.sql': 'create table t (price_a real, price_b real, price_c real);' }, { offset: 1 });
    expect(three.summary).toMatch(/ These are findings 2-3 of 3, the last\.$/); // offset 1 is a later page (round 13)
    const clean = await lint({ 'db/migrations/0001.sql': 'create table t (price bigint);' }, { offset: 50 });
    expect([clean.findings_truncated, clean.summary.includes('offset')]).toEqual([false, false]); // nothing to page on a clean schema (round 13)
    expect((await lint({ 'db/migrations/0001.sql': 'create table t (price real);' }, { offset: 100 })).summary).toMatch(/ No findings from offset 100: there is 1\.$/); // round 16
    expect((await lint(files, { offset: 999 })).findings).toEqual([]);
    // Review round 9: the summary says so, as the ledger's does.
    expect(r.summary).toMatch(/ Not every finding is listed \(findings_truncated\): pass next_offset as offset for the next ones\.$/);
    expect([r.files_applied.length, r.files_applied_truncated, r.files_applied_count]).toEqual([30, true, 35]);
    // Review round 19: exactly 30 files are all listed, so the list is not cut short.
    const thirty = await lint(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`db/migrations/${String(i).padStart(4, '0')}.sql`, 'select 1;'])));
    expect([thirty.files_applied.length, thirty.files_applied_truncated, thirty.files_applied_count]).toEqual([30, false, 30]);
    expect([r.other_float_columns.length, r.other_float_columns_count]).toEqual([30, 32]);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    // Exactly 50 findings are all there: nothing is cut.
    const fifty = Array.from({ length: 50 }, (_, i) => `price_${i} double precision`).join(', ');
    const all = await lint({ 'db/migrations/0001.sql': `create table big (${fifty});` });
    expect([all.findings.length, all.findings_truncated, all.error_count]).toEqual([50, false, 50]);
    expect(all.summary).not.toContain('Not every finding');
  });

  it('writes counts of a thousand or more with a thousands separator, as the ledger does', async () => {
    const columns = Array.from({ length: 1000 }, (_, i) => `price_${i} double precision`).join(', ');
    const r = await lint({ 'db/migrations/0001.sql': `create table big (${columns});` });
    expect(r.summary).toMatch(/^1,000 problems in 1,000 money columns \(1,000 errors, 0 warnings\)\./);
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
    expect(r.summary).toMatch(/ Not every finding is listed \(findings_truncated\): pass next_offset as offset for the next ones\.$/);
    // Fewer than 50, cut only to fit: the summary says so too (review round 9).
    const fewer = await lint({ [`db/migrations/${'d'.repeat(100)}/0001.sql`]: `create table t_${'y'.repeat(61)} (${columns.slice(0, 45).join(', ')});` });
    expect([fewer.findings.length < 45, fewer.findings_truncated, fewer.error_count]).toEqual([true, true, 45]);
    expect(fewer.next_offset).toBe(fewer.findings.length); // the next page starts where this one was cut (round 11)
    // Review round 12: on a later page too, it carries on from where that page was cut, never back.
    const later = await lint({ [`db/migrations/${'d'.repeat(100)}/0001.sql`]: `create table t_${'y'.repeat(61)} (${columns.join(', ')});` }, { offset: 10 });
    expect(later.next_offset).toBe(10 + later.findings.length);
    expect(later.summary).toMatch(/ pass next_offset as offset for the next ones\.$/); // a middle page too (round 13)
    expect(fewer.summary.split('Not every finding').length).toBe(2); // once, however many were cut to fit (review round 10)
    expect(fewer.summary).toMatch(/ Not every finding is listed \(findings_truncated\): pass next_offset as offset for the next ones\.$/);
    expect(r.findings[0]?.column).toBe(`price_00_${'x'.repeat(54)}`);
  });

  it('keeps one finding within the budget however deep its folder: a long path is cut in the middle', async () => {
    // Folder names of characters that each show as a six-character escape: U+0085 on Windows, which
    // refuses C0 controls in names; U+0001 elsewhere, one byte each, within the path limits of Linux
    // (4,096 bytes) and macOS (1,024). On Linux and Windows the whole path shows as over 20,000 characters.
    const char = process.platform === 'win32' ? '\u{85}' : '\u{1}';
    const depth = process.platform === 'win32' ? 30 : process.platform === 'darwin' ? 4 : 18;
    const folders = Array.from({ length: depth }, () => char.repeat(200)).join('/');
    const r = await lint({ [`db/migrations/${folders}/0001.sql`]: 'create table t (total double precision);' });
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(20_000);
    expect(r.findings.length).toBe(1);
    const shown = r.findings[0]?.introduced_in ?? '';
    expect([...shown].length).toBeLessThanOrEqual(400); // PATH_MAX (SPEC.md §2.4)
    expect(shown).toMatch(/^p\d+\/db\/migrations\/(?:\\u00(?:01|85))+…(?:\\u00(?:01|85))+\/0001\.sql$/);
  });
});
