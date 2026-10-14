// money_lint_schema (SPEC.md §3): which files run, links, names from a hostile project, failures and
// their hints, platforms (Supabase, setup, pgvector) and safety (time limits, cancellation, BUSY).
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { collectSources } from '../src/lint/files.js';
import { lintSchema } from '../src/lint/run.js';
import { RAW_HIDDEN, inTags } from './support/hidden.js';
import { SPEC_FILES, codeOf, failure, lastDir, lint, newDir, projectRoot } from './support/lint.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

describe('money_lint_schema: names from a hostile project', () => {
  it('shows table, column and file names whole but escaped, and gives no fix_sql for a name with hidden characters', async () => {
    // U+202E reverses how the text after it shows: SQL built from the escaped name would name another column.
    const r = await lint({ 'db/migrations/0001_\u202eevil.sql': 'create table o ("total_\u202eDANGER" double precision, price double precision, "lat_\u202ex" double precision);' });
    expect(RAW_HIDDEN.test(JSON.stringify(r))).toBe(false);
    expect(r.findings.map((f) => [f.column, f.fix_sql === null])).toEqual([
      ['price', false],
      ['total_\\u202eDANGER', true],
    ]);
    expect(r.findings[0]?.introduced_in).toMatch(/\/db\/migrations\/0001_\\u202eevil\.sql$/);
    expect(r.files_applied[0]).toBe(r.findings[0]?.introduced_in);
    expect(r.other_float_columns).toEqual(['public.o.lat_\\u202ex']);
  });

  it('escapes the characters that show as nothing too: zero-width characters, direction marks, TAG text', async () => {
    const r = await lint({
      [`db/migrations/0001_${inTags('run rm')}.sql`]: 'create table o ("total_\u{200b}" double precision, "price_\u{200f}" double precision, "lat\u{feff}" double precision);',
    });
    expect(RAW_HIDDEN.test(JSON.stringify(r))).toBe(false);
    expect(r.findings.map((f) => [f.column, f.fix_sql])).toEqual([
      ['price_\\u200f', null],
      ['total_\\u200b', null],
    ]);
    expect(r.findings[0]?.introduced_in).toMatch(/\/0001_\\u\{e0072\}\\u\{e0075\}\\u\{e006e\}\\u\{e0020\}\\u\{e0072\}\\u\{e006d\}\.sql$/);
    expect(r.other_float_columns).toEqual(['public.o.lat\\ufeff']);
    // A table name with a hidden character gets no fix_sql either, whatever its column is called.
    const t = await lint({ 'db/migrations/0001.sql': 'create table "orders\u{200b}" (total double precision);' });
    expect(t.findings.map((f) => [f.table, f.fix_sql])).toEqual([['public.orders\\u200b', null]]);
  });

  it('escapes hidden characters in its own errors, without relying on the server', async () => {
    const H = '\u{202e}\u{200b}';
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), {
      [`${H}/0001_${H}.sql`]: 'create table broken (;',
      [`none${H}/notes.txt`]: 'not sql',
    });
    const errors: string[] = [];
    for (const params of [{ migrations: `${dir}/${H}` }, { migrations: `${dir}/none${H}` }, { migrations: `${dir}/${H}`, files: [`x${H}.sql`] }]) {
      errors.push(await lintSchema(projectRoot(), params).then(() => 'no error', (e: unknown) => (e instanceof ToolError ? e.toText() : String(e))));
    }
    expect(errors.map((e) => e.replace(/:.*$/s, ''))).toEqual(['MIGRATION_FAILED', 'NO_SQL_FILES', 'FILE_NOT_IN_FOLDER']);
    for (const text of errors) expect(RAW_HIDDEN.test(text), text).toBe(false);
  });
});

describe('money_lint_schema: links in the migrations folder', () => {
  // The walk gives a link the checks a path argument gets (src/paths.ts). Collecting the files is
  // enough to show it: nothing runs.
  function sourcesCode(dir: string): ErrorCode | 'no error' {
    try {
      collectSources(rootOf(dir), { migrations: 'db/migrations' });
      return 'no error';
    } catch (err) {
      if (err instanceof ToolError) return err.code;
      throw err;
    }
  }

  it('refuses a folder link that leads outside the project, and a folder link to nothing', () => {
    // Folder links need no privilege (junctions on Windows), so this test never skips.
    const outside = tempDir();
    writeTree(outside, { 'other/0001.sql': 'select 1;' });
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': 'select 1;', 'gone/0002.sql': 'select 1;' });
    expect(trySymlink(path.join(outside, 'other'), path.join(dir, 'db', 'migrations', 'out'), 'dir')).toBe(true);
    expect(sourcesCode(dir)).toBe('PATH_OUTSIDE_ROOT');
    rmSync(path.join(dir, 'db', 'migrations', 'out'), { recursive: true, force: true });
    expect(trySymlink(path.join(dir, 'gone'), path.join(dir, 'db', 'migrations', 'legacy'), 'dir')).toBe(true);
    rmSync(path.join(dir, 'gone'), { recursive: true, force: true });
    expect(sourcesCode(dir)).toBe('PATH_NOT_FOUND');
  });

  it('refuses a .sql link to a secrets file or to a file that is not .sql, even inside the project', (ctx) => {
    const dir = tempDir();
    writeTree(dir, { '.env': 'STRIPE_SECRET_KEY=x\n', 'notes.txt': 'select 1;', 'db/migrations/0001.sql': 'select 1;' });
    if (!trySymlink(path.join(dir, '.env'), path.join(dir, 'db', 'migrations', '0002.sql'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    expect(sourcesCode(dir)).toBe('SENSITIVE_PATH');
    rmSync(path.join(dir, 'db', 'migrations', '0002.sql'));
    expect(trySymlink(path.join(dir, 'notes.txt'), path.join(dir, 'db', 'migrations', '0002.sql'), 'file')).toBe(true);
    expect(sourcesCode(dir)).toBe('FILE_TYPE_NOT_ALLOWED');
  });

  it('walks a folder that links to itself only once', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': 'select 1;' });
    expect(trySymlink(path.join(dir, 'db', 'migrations'), path.join(dir, 'db', 'migrations', 'again'), 'dir')).toBe(true);
    expect(collectSources(rootOf(dir), { migrations: 'db/migrations' }).files.map((f) => f.rel)).toEqual(['db/migrations/0001.sql']);
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

  it('runs only the up part of files that hold both directions, and leaves out undo and rollback files', async () => {
    // goose, sql-migrate, node-pg-migrate, tern and dbmate (with options) write these markers; a comment
    // that only starts like dbmate's marker is not one.
    const r = await lint({
      'db/migrations/0001_goose.sql': '-- +goose Up\ncreate table a (price double precision);\n-- +goose StatementBegin\nselect 1;\n-- +goose StatementEnd\n\n-- +goose Down\ndrop table a;\n',
      'db/migrations/0002_sql_migrate.sql': '-- +migrate Up\ncreate table b (fee double precision);\n-- +migrate Down\ndrop table b;\n',
      'db/migrations/0003_node_pg_migrate.sql': '-- Up Migration\ncreate table c (total double precision);\n-- Down Migration\ndrop table c;\n',
      'db/migrations/0004_tern.sql': 'create table d (cost double precision);\n---- create above / drop below ----\ndrop table d;\n',
      'db/migrations/0005_dbmate.sql': '-- migrate:up transaction:false\r\ncreate table e (amount double precision);\r\n-- migrate:down transaction:false\r\ndrop table e;\r\n',
      'db/migrations/0006_comment.sql': '-- migrate:downgrade is just a comment here\ncreate table f (balance double precision);\n',
      'db/migrations/0007_a.undo.sql': 'drop table a;',
      'db/migrations/0008_b.rollback.sql': 'drop table b;',
      // Only a name ending in ".down.sql" is a down file: this one just ends in "down" before ".sql".
      'db/migrations/0009_fee_breakdown.sql': 'create table g (fee double precision);',
    });
    expect(r.findings.map((f) => f.table)).toEqual(['public.a', 'public.b', 'public.c', 'public.d', 'public.e', 'public.f', 'public.g']);
    expect(r.files_applied_count).toBe(7);
  });

  it('leaves out Diesel down.sql files, which sort before up.sql in each migration folder', async () => {
    const r = await lint({
      'db/migrations/2024-01-01-000000_create_orders/up.sql': 'create table orders (total double precision);',
      'db/migrations/2024-01-01-000000_create_orders/down.sql': 'drop table orders;',
    });
    expect([r.files_applied_count, r.findings.map((f) => f.table)]).toEqual([1, ['public.orders']]);
  });

  it('finds the markers in files with CR LF line ends and nothing after the marker', async () => {
    const r = await lint({
      'db/migrations/0001_dbmate.sql': '-- migrate:up\r\ncreate table a (price double precision);\r\n-- migrate:down\r\ndrop table a;\r\n',
      'db/migrations/0002_node_pg_migrate.sql': '-- Up Migration\r\ncreate table b (fee double precision);\r\n-- Down Migration\r\ndrop table b;\r\n',
      'db/migrations/0003_goose.sql': '-- +goose Up\r\ncreate table c (cost double precision);\r\n-- +goose Down\r\ndrop table c;\r\n',
      'db/migrations/0004_sql_migrate.sql': '-- +migrate Up\r\ncreate table d (total double precision);\r\n-- +migrate Down\r\ndrop table d;\r\n',
    });
    expect(r.findings.map((f) => f.table)).toEqual(['public.a', 'public.b', 'public.c', 'public.d']);
  });

  it('cuts nothing at a comment that only looks like a down marker: a down marker counts only next to the up marker of the same tool', async () => {
    // A Supabase file with a note for a manual rollback: before, the lint stopped at the note and said
    // "No problems" about a float amount it never saw.
    const r = await lint({
      'db/migrations/0001.sql': 'create table a (id int);',
      'db/migrations/0002.sql': '-- Down migration (manual, if ever needed): drop table orders;\ncreate table orders (id int, amount double precision);\n',
      'db/migrations/0003.sql': '-- migrate:down is not used in this project\ncreate table refunds (total double precision);\n',
    });
    expect(r.findings.map((f) => f.table)).toEqual(['public.orders', 'public.refunds']);
  });

  it('reads node-pg-migrate files as its own parser does: an indented marker, more dashes, down before up', async () => {
    const r = await lint({
      'db/migrations/0001.sql': '  -- Up Migration\ncreate table a (price double precision);\n---- Down Migration\ndrop table a;\n',
      'db/migrations/0002.sql': '-- Down Migration\ndrop table b;\n-- Up Migration\ncreate table b (fee double precision);\n',
    });
    expect(r.findings.map((f) => f.table)).toEqual(['public.a', 'public.b']);
  });

  it('keeps line numbers exact after a down part that comes first', async () => {
    const e = await failure({ 'db/migrations/0001.sql': '-- migrate:down\ndrop table x;\n-- migrate:up\ncreate table t (x nosuchtype);\n' });
    expect(e.message).toMatch(/0001\.sql line 4, column 19: type "nosuchtype" does not exist/);
  });

  it('says plainly when no table is left to check, instead of reporting a clean schema', async () => {
    const r = await lint({ 'db/migrations/0001.sql': '-- a format that keeps both directions\ncreate table t (price double precision);\ndrop table t;\n' });
    expect(r.summary).toBe(
      'No tables exist after the 1 migration file, so nothing was checked. If a file also holds its down step, that step dropped what the file created: pass files, or lint a copy without the down steps.',
    );
  });

  it('explains a folder that only holds down steps', async () => {
    expect((await failure({ 'db/migrations/0001.down.sql': 'drop table t;' })).toText()).toMatch(
      /^NO_SQL_FILES: "p\d+\/db\/migrations" holds no migrations to run\. Its 1 \.sql file is a down step /,
    );
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
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), files);
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/db/migrations/a.sql`, files: ['a.sql'] })).rejects.toMatchObject({ code: 'FILE_NOT_IN_FOLDER' });
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
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), { 'schema.sql': dump });
    const r = await lintSchema(projectRoot(), { migrations: `${dir}/schema.sql` });
    expect(r.findings.map((f) => `${f.table}.${f.column}`)).toEqual(['public.invoices.amount']);
  });

  it('explains a folder with no SQL in it', async () => {
    const e = await failure({ 'db/migrations/001_init.ts': 'export {}', 'db/migrations/002.ts': '', 'db/migrations/readme.md': '' });
    expect(e.code).toBe('NO_SQL_FILES');
    expect(e.message).toMatch(/holds no \.sql files\. It holds 2 \.ts, 1 \.md files\./);
  });

  it('refuses more than 2,000 files, a file over 5 MiB, and more than 20 MiB in all', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= 2000; i += 1) many[`db/migrations/${i}.sql`] = '';
    expect(await codeOf(many)).toBe('TOO_MANY_FILES');
    expect(await codeOf({ 'db/migrations/big.sql': `-- ${'x'.repeat(5 * 1024 * 1024)}` })).toBe('FILE_TOO_LARGE');
    const nearly = `-- ${'x'.repeat(4.5 * 1024 * 1024)}`;
    const five = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`db/migrations/000${i}.sql`, nearly]));
    expect((await failure(five)).message).toMatch(/^The migrations together are over 20 MiB\.$/);
  });
});

describe('money_lint_schema: failures', () => {
  it('names the file, line and column of a failing statement', async () => {
    const e = await failure({
      'db/migrations/0001.sql': 'create table a (id int);',
      'db/migrations/0002.sql': 'create table b (id int);\n\ncreate table c (x nosuchtype);\n',
    });
    expect(e.code).toBe('MIGRATION_FAILED');
    expect(e.message).toBe(`${lastDir()}/db/migrations/0002.sql line 3, column 19: type "nosuchtype" does not exist (SQLSTATE 42704).`);
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

  it('fits the hint to what real PostgreSQL reports', async () => {
    const cases: Array<[files: Record<string, string>, state: string, hint: RegExp]> = [
      [{ 'db/migrations/0001.sql': 'create table t (id int);\ncreate index concurrently t_id on t (id);\n' }, '25001', /CREATE INDEX CONCURRENTLY cannot run/],
      // A value added to a type made in the same file may be used at once; to a type an earlier file made, not.
      [{ 'db/migrations/0001.sql': "create type s as enum ('a');", 'db/migrations/0002.sql': "alter type s add value 'b';\nselect 'b'::s;\n" }, '55P04', /a new enum value cannot be used in the transaction that adds it/],
      [{ 'db/migrations/0001.sql': 'CREATE TABLE public.t (a integer);\nCOPY public.t (a) FROM stdin;\n1\n\\.\n' }, '42601', /a pg_dump with data/],
      [{ 'db/migrations/0001.sql': "select repeat('x', 2000000000);" }, '54000', /^The file needs more than the lint database can give it/],
      [{ 'db/migrations/0001_view.sql': 'create view v as select * from orders;', 'db/migrations/0002_orders.sql': 'create table orders (id int);' }, '42P01', /^If one of your migrations creates it, the files ran out of order/],
      [{ 'db/migrations/0001.sql': 'select no_such_function();' }, '42883', /^If one of your migrations creates it, the files ran out of order.* preset "supabase"/],
    ];
    for (const [files, state, hint] of cases) {
      const e = await failure(files);
      expect(e.message, state).toContain(`(SQLSTATE ${state})`);
      expect(e.fix, state).toMatch(hint);
    }
  });

  it('reports a broken setup file as SETUP_FAILED', async () => {
    expect(await codeOf({ 'db/migrations/0001.sql': 'select 1;', 'setup.sql': 'create rol x;' }, { setup: 'setup.sql' })).toBe('SETUP_FAILED');
  });

  it('refuses a migration that is not UTF-8, and a setup file that is not as SETUP_FAILED', async () => {
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), { 'db/migrations/0001.sql': Buffer.from([0x73, 0x65, 0x6c, 0xff]), 'ok/0001.sql': 'select 1;', 'setup.sql': Buffer.from([0xff]) });
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/db/migrations` })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/ok`, setup: `${dir}/setup.sql` })).rejects.toMatchObject({ code: 'SETUP_FAILED' });
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

  it('creates every object SPEC.md §3.4 lists for the preset', async () => {
    const r = await lint(
      {
        'db/migrations/0001.sql': [
          'grant usage on schema public to anon, authenticated, service_role, authenticator, supabase_admin, supabase_auth_admin, supabase_storage_admin;',
          'create table public.notes (id uuid primary key default extensions.uuid_generate_v4(), author uuid references auth.users (id), ' +
            "email text default auth.email(), secret text default extensions.crypt('x', extensions.gen_salt('bf')), fee double precision);",
          'alter table public.notes enable row level security;',
          "create policy \"admins\" on public.notes for all to authenticated using ((auth.jwt() ->> 'role') = 'admin' and auth.role() = 'authenticated' and author = auth.uid());",
          'create policy "images" on storage.objects for insert to authenticated with check ' +
            "(storage.extension(name) in ('png', 'jpg') and storage.filename(name) <> '' and (storage.foldername(name))[1] = 'avatars');",
          "insert into storage.buckets (id, name) values ('avatars', 'avatars');",
          'alter publication supabase_realtime add table public.notes;',
        ].join('\n'),
      },
      { preset: 'supabase' },
    );
    expect(r.findings.map((f) => `${f.table}.${f.column}`)).toEqual(['public.notes.fee']);
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

  it('runs a setup file that lies in the migrations folder once, as setup', async () => {
    const files = { 'db/migrations/0000_platform.sql': 'create role authenticated;', 'db/migrations/0001.sql': 'create table t (amount double precision); grant select on t to authenticated;' };
    const walked = await lint(files, { setup: 'db/migrations/0000_platform.sql' });
    expect([walked.files_applied.map((f) => f.split('/').at(-1)), walked.error_count]).toEqual([['0001.sql'], 1]);
    const listed = await lint(files, { setup: 'db/migrations/0000_platform.sql', files: ['0000_platform.sql', '0001.sql'] });
    expect([listed.files_applied_count, listed.error_count]).toEqual([1, 1]);
  });

  it('says that nothing was checked when every table comes from setup', async () => {
    const r = await lint({ 'setup.sql': 'create table platform (fee double precision);', 'db/migrations/0001.sql': 'select 1;' }, { setup: 'setup.sql' });
    expect(r.summary).toBe('No table was created or changed by the 1 migration file, so nothing was checked: the tables that exist come from setup or the preset.');
  });

  it('has pgvector', async () => {
    const r = await lint({ 'db/migrations/0001.sql': 'create extension vector; create table docs (embedding vector(3), price double precision);' });
    expect(r.findings.map((f) => f.column)).toEqual(['price']);
  });
});

describe('money_lint_schema: safety', () => {
  it("cannot read the computer's files from a migration, by any of the three ways PostgreSQL offers", async () => {
    // A real file on this machine, with a marker that must never come back.
    const secretDir = tempDir();
    writeTree(secretDir, { 'secret.txt': 'MARKER-7c1e-host-secret\n' });
    const secret = path.join(secretDir, 'secret.txt').replaceAll('\\', '/');
    for (const sql of [
      `create table h (line text);\ncopy h from '${secret}';`,
      `select pg_read_file('${secret}');`,
      `select lo_import('${secret}');`,
    ]) {
      const e = await failure({ 'db/migrations/0001.sql': sql });
      expect(e.code, sql).toBe('MIGRATION_FAILED');
      expect(e.toText(), sql).not.toContain('MARKER-7c1e');
    }
  });

  it('reports a statement that leaves the database unusable (COPY ... PROGRAM) against its file', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'create table p (line text);', 'db/migrations/0002.sql': "copy p from program 'echo hi';" });
    expect(e.code).toBe('MIGRATION_FAILED');
    expect(e.message).toMatch(/0002\.sql: after this file the database (no longer answers correctly|stopped answering)/);
  });

  it('stops an endless migration at the time limit', async () => {
    // 10 s leaves the database's start-up (about 1.5 s, more on a loaded machine) well inside the limit.
    // That the thread itself is killed is proven in test/database.test.ts (its heartbeat stops).
    const started = Date.now();
    const e = await failure({ 'db/migrations/0001.sql': 'select 1;', 'db/migrations/0002_loop.sql': 'do $$ begin loop end loop; end $$;' }, { timeout_seconds: 10 });
    expect(e.code).toBe('TIMEOUT');
    expect(e.message).toMatch(/ran out of time \(10 s\) while running p\d+\/db\/migrations\/0002_loop\.sql/);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('stops when the call is cancelled', async () => {
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), { 'db/migrations/0001.sql': 'do $$ begin loop end loop; end $$;' });
    const controller = new AbortController();
    const started = Date.now();
    const run = lintSchema(projectRoot(), { migrations: `${dir}/db/migrations` }, controller.signal);
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
