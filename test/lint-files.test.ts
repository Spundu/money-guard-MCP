// money_lint_schema (SPEC.md §3): which files run, links, names from a hostile project, failures and
// their hints, platforms (Supabase, setup, pgvector) and safety (time limits, cancellation, BUSY).
import { rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasUnsafe } from '../src/echo.js';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { collectSources } from '../src/lint/files.js';
import { lintSchema } from '../src/lint/run.js';
import { SPEC_FILES, codeOf, failure, lastDir, lint, newDir, projectRoot } from './support/lint.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

describe('money_lint_schema: names from a hostile project', () => {
  it('shows table, column and file names whole but escaped, and gives no fix_sql for a name with hidden characters', async () => {
    // U+202E reverses how the text after it shows: SQL built from the escaped name would name another column.
    const r = await lint({ 'db/migrations/0001_\u202eevil.sql': 'create table o ("total_\u202eDANGER" double precision, price double precision, "lat_\u202ex" double precision);' });
    expect(hasUnsafe(JSON.stringify(r))).toBe(false);
    expect(r.findings.map((f) => [f.column, f.fix_sql === null])).toEqual([
      ['price', false],
      ['total_\\u202eDANGER', true],
    ]);
    expect(r.findings[0]?.introduced_in).toMatch(/\/db\/migrations\/0001_\\u202eevil\.sql$/);
    expect(r.files_applied[0]).toBe(r.findings[0]?.introduced_in);
    expect(r.other_float_columns).toEqual(['public.o.lat_\\u202ex']);
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
