import { createHash } from 'node:crypto';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { lintSchema, type LintParams } from '../src/lint/run.js';
import type { Root } from '../src/paths.js';
import { rootOf, tempDir, writeTree } from './support/tmp.js';

let root: Root;
let n = 0;

beforeAll(() => {
  root = rootOf(tempDir());
});

/** Write `files` under a fresh folder of the project and lint it. */
async function lint(files: Record<string, string>, params: Partial<LintParams> = {}) {
  const dir = `p${(n += 1)}`;
  writeTree(path.join(root.real, dir), files);
  return lintSchema(root, { migrations: `${dir}/db/migrations`, ...params, ...(params.setup ? { setup: `${dir}/${params.setup}` } : {}) });
}

async function failure(files: Record<string, string>, params: Partial<LintParams> = {}): Promise<ToolError> {
  try {
    await lint(files, params);
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('expected a ToolError');
}

async function codeOf(files: Record<string, string>, params: Partial<LintParams> = {}): Promise<ErrorCode> {
  return (await failure(files, params)).code;
}

const SPEC_FILES = {
  'db/migrations/0001_init.sql': "create table orders (id bigserial primary key, total double precision not null, currency text not null default 'GBP');\n",
  'db/migrations/0002_fees.sql': 'alter table orders add column platform_fee numeric(10,2) not null default 0;\n',
  'db/migrations/0003_payouts.sql': 'create table payouts (id bigserial primary key, amount_pence bigint not null, fee_pence bigint not null);\n',
};

describe('money_lint_schema: the SPEC.md §3.10 example', () => {
  it('gives exactly the documented result', async () => {
    const r = await lint(SPEC_FILES);
    const dir = `p${n}`;
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

describe('money_lint_schema: which files run', () => {
  it('runs files in natural order (V2 before V10)', async () => {
    const r = await lint({
      'db/migrations/V1__init.sql': 'create table t (id int);',
      'db/migrations/V2__add.sql': 'alter table t add column price double precision;',
      'db/migrations/V10__use.sql': 'alter table t alter column price set not null;',
    });
    expect(r.files_applied.map((f) => f.split('/').at(-1))).toEqual(['V1__init.sql', 'V2__add.sql', 'V10__use.sql']);
    expect(r.findings[0]?.introduced_in).toMatch(/V2__add\.sql$/);
  });

  it('walks sub-folders (Prisma), skips down steps, and stops a dbmate file at its down marker', async () => {
    const r = await lint({
      'db/migrations/20240101_init/migration.sql': 'create table a (price double precision);',
      'db/migrations/20240202_more/migration.sql': 'create table b (fee double precision);',
      'db/migrations/20240303_x.up.sql': 'create table c (total double precision);',
      'db/migrations/20240303_x.down.sql': 'drop table c;',
      'db/migrations/20240404_d.sql': '-- migrate:up\ncreate table d (cost double precision);\n\n-- migrate:down\ndrop table d;\n',
      'db/migrations/notes.md': 'not sql',
    });
    expect(r.findings.map((f) => f.table)).toEqual(['public.a', 'public.b', 'public.c', 'public.d']);
    expect(r.files_applied_count).toBe(4);
  });

  it('runs exactly the files given, in the order given', async () => {
    const r = await lint(
      {
        'db/migrations/b.sql': 'alter table t add column price real;',
        'db/migrations/a.sql': 'create table t (id int);',
        'db/migrations/broken.sql': 'this is not sql;',
      },
      { files: ['a.sql', 'b.sql'] },
    );
    expect(r.files_applied.map((f) => f.split('/').at(-1))).toEqual(['a.sql', 'b.sql']);
  });

  it('refuses files that are missing or outside the folder, or given with a single file', async () => {
    const files = { 'db/migrations/a.sql': 'select 1;', 'db/other.sql': 'select 1;' };
    expect(await codeOf(files, { files: ['nope.sql'] })).toBe('FILE_NOT_IN_FOLDER');
    expect(await codeOf(files, { files: ['../other.sql'] })).toBe('FILE_NOT_IN_FOLDER');
    const dir = `p${(n += 1)}`;
    writeTree(path.join(root.real, dir), files);
    await expect(lintSchema(root, { migrations: `${dir}/db/migrations/a.sql`, files: ['a.sql'] })).rejects.toMatchObject({ code: 'FILE_NOT_IN_FOLDER' });
  });

  it('lints one schema file, such as a pg_dump 18 file with \\restrict lines and an empty search_path', async () => {
    const dump = [
      '--',
      '-- PostgreSQL database dump',
      '--',
      '\\restrict AbCdEf123',
      'SET statement_timeout = 0;',
      "SELECT pg_catalog.set_config('search_path', '', false);",
      'CREATE TABLE public.invoices (id integer NOT NULL, amount double precision);',
      '\\unrestrict AbCdEf123',
      '',
    ].join('\n');
    const dir = `p${(n += 1)}`;
    writeTree(path.join(root.real, dir), { 'schema.sql': dump });
    const r = await lintSchema(root, { migrations: `${dir}/schema.sql` });
    expect(r.findings.map((f) => `${f.table}.${f.column}`)).toEqual(['public.invoices.amount']);
  });

  it('explains a folder with no SQL in it', async () => {
    const e = await failure({ 'db/migrations/001_init.ts': 'export {}', 'db/migrations/002.ts': '', 'db/migrations/readme.md': '' });
    expect(e.code).toBe('NO_SQL_FILES');
    expect(e.message).toMatch(/holds no \.sql files\. It holds 2 \.ts, 1 \.md files\./);
  });

  it('refuses more than 2,000 files and files over 5 MiB', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= 2000; i += 1) many[`db/migrations/${i}.sql`] = '';
    expect(await codeOf(many)).toBe('TOO_MANY_FILES');
    expect(await codeOf({ 'db/migrations/big.sql': `-- ${'x'.repeat(5 * 1024 * 1024)}` })).toBe('FILE_TOO_LARGE');
  });
});

describe('money_lint_schema: failures', () => {
  it('names the file, line and column of a failing statement', async () => {
    const e = await failure({
      'db/migrations/0001.sql': 'create table a (id int);',
      'db/migrations/0002.sql': 'create table b (id int);\n\ncreate table c (x nosuchtype);\n',
    });
    expect(e.code).toBe('MIGRATION_FAILED');
    expect(e.message).toBe(`p${n}/db/migrations/0002.sql line 3, column 19: type "nosuchtype" does not exist (SQLSTATE 42704).`);
    expect(e.fix).toMatch(/preset "supabase"/);
  });

  it('counts the column in characters, as PostgreSQL does, past multi-byte text', async () => {
    const e = await failure({ 'db/migrations/0001.sql': "-- £€😀\nselect 'é', nosuchcolumn;\n" });
    expect(e.message).toMatch(/line 2, column 13: column "nosuchcolumn" does not exist/);
  });

  it('points at psql meta-commands', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'select 1;\n\\connect other\n' });
    expect(e.message).toMatch(/line 2, column 1: syntax error at or near "\\"/);
    expect(e.fix).toMatch(/psql meta-command/);
  });

  it('lists the extensions PGlite has when one is missing', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'create extension postgis;' });
    expect(e.message).toMatch(/extension "postgis" is not available/);
    expect(e.fix).toMatch(/^PGlite does not have that extension\. It has: .*citext.*pgcrypto.*uuid-ossp.*vector/);
  });

  it('reports a broken setup file as SETUP_FAILED', async () => {
    expect(await codeOf({ 'db/migrations/0001.sql': 'select 1;', 'setup.sql': 'create rol x;' }, { setup: 'setup.sql' })).toBe('SETUP_FAILED');
  });

  it('refuses a migration that is not UTF-8', async () => {
    const dir = `p${(n += 1)}`;
    writeTree(path.join(root.real, dir), { 'db/migrations/0001.sql': Buffer.from([0x73, 0x65, 0x6c, 0xff]) });
    await expect(lintSchema(root, { migrations: `${dir}/db/migrations` })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
  });
});

describe('money_lint_schema: platforms', () => {
  const SUPABASE = {
    'db/migrations/0001_profiles.sql': [
      'create extension if not exists moddatetime schema extensions;',
      'create table public.profiles (',
      '  id uuid primary key references auth.users (id) on delete cascade,',
      '  balance double precision not null default 0,',
      '  updated_at timestamptz',
      ');',
      'alter table public.profiles enable row level security;',
      'create policy "own profile" on public.profiles for select to authenticated using (auth.uid() = id);',
      'grant select on public.profiles to anon, authenticated;',
      'create table public.uploads (id uuid primary key default uuid_generate_v4(), path text);',
      "insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);",
      'create policy "own files" on storage.objects for select to authenticated using ((storage.foldername(name))[1] = auth.uid()::text);',
      'alter publication supabase_realtime add table public.profiles;',
    ].join('\n'),
  };

  it("runs ordinary Supabase migrations with the preset, and checks only the project's own columns", async () => {
    const r = await lint(SUPABASE, { preset: 'supabase' });
    expect(r.findings.map((f) => `${f.code} ${f.table}.${f.column}`)).toEqual(['FLOAT_MONEY public.profiles.balance']);
    expect(r.tables_checked).toBe(2);
  });

  it('suggests the preset when Supabase objects are missing, and setup when the preset lacks one', async () => {
    const without = await failure(SUPABASE);
    expect([without.code, without.fix]).toEqual(['MIGRATION_FAILED', expect.stringMatching(/preset "supabase"/)]);
    const lacking = await failure({ 'db/migrations/0001.sql': "select net.http_post('https://example.com');" }, { preset: 'supabase' });
    expect(lacking.fix).toMatch(/^The Supabase preset does not create this\. Pass setup/);
  });

  it('runs a setup file before the migrations and does not check what it creates', async () => {
    const r = await lint(
      {
        'setup.sql': 'create schema legacy; create table legacy.prices (amount double precision); create role app_user;',
        'db/migrations/0001.sql': 'create table public.items (price double precision); grant select on public.items to app_user;',
      },
      { setup: 'setup.sql' },
    );
    expect(r.findings.map((f) => f.table)).toEqual(['public.items']);
  });

  it('has pgvector', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create extension vector; create table docs (embedding vector(3), price double precision);' });
    expect(r.findings.map((f) => f.column)).toEqual(['price']);
  });
});

describe('money_lint_schema: safety', () => {
  it("cannot read the computer's files from a migration", async () => {
    const e = await failure({ 'db/migrations/0001.sql': "create table h (line text);\ncopy h from '/etc/hosts';\nselect pg_read_file('C:/Windows/win.ini');" });
    expect(e.message).toMatch(/could not open file "\/etc\/hosts" for reading: No such file or directory/);
  });

  it('reports a statement that leaves the database unusable (COPY ... PROGRAM) against its file', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'create table p (line text);', 'db/migrations/0002.sql': "copy p from program 'echo hi';" });
    expect(e.code).toBe('MIGRATION_FAILED');
    expect(e.message).toMatch(/0002\.sql: after this file the database (no longer answers correctly|stopped answering)/);
  });

  it('stops an endless migration at the time limit (the worker is killed mid-WebAssembly)', async () => {
    const started = Date.now();
    const e = await failure({ 'db/migrations/0001.sql': 'select 1;', 'db/migrations/0002_loop.sql': 'do $$ begin loop end loop; end $$;' }, { timeout_seconds: 5 });
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toMatch(/ran out of time \(5 s\) while running p\d+\/db\/migrations\/0002_loop\.sql/);
    expect(Date.now() - started).toBeLessThan(9000);
  });

  it('stops when the call is cancelled', async () => {
    const dir = `p${(n += 1)}`;
    writeTree(path.join(root.real, dir), { 'db/migrations/0001.sql': 'do $$ begin loop end loop; end $$;' });
    const controller = new AbortController();
    const started = Date.now();
    const run = lintSchema(root, { migrations: `${dir}/db/migrations` }, controller.signal);
    setTimeout(() => controller.abort(new Error('cancelled by the client')), 2500);
    await expect(run).rejects.toThrow('cancelled by the client');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('runs one lint at a time and says BUSY to a second', async () => {
    const first = lint(SPEC_FILES);
    await expect(lint(SPEC_FILES)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(first).resolves.toMatchObject({ error_count: 1 });
    await expect(lint(SPEC_FILES)).resolves.toMatchObject({ error_count: 1 }); // free again afterwards
  });

  it('gives the same result for the same files', async () => {
    const strip = (r: Awaited<ReturnType<typeof lint>>) =>
      JSON.stringify({ ...r, migrations: '', migrations_sha256: '', files_applied: [], findings: r.findings.map((f) => ({ ...f, introduced_in: '' })) });
    expect(strip(await lint(SPEC_FILES))).toBe(strip(await lint(SPEC_FILES)));
  });
});
