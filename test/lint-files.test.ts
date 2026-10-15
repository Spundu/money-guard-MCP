// money_lint_schema (SPEC.md §3): which files run, links, and names from a hostile project. Failures,
// platforms and safety are in lint-failures.test.ts.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolError, type ErrorCode } from '../src/errors.js';
import { collectSources, prepareSql } from '../src/lint/files.js';
import { lintSchema } from '../src/lint/run.js';
import { RAW_HIDDEN, inTags } from './support/hidden.js';
import { codeOf, failure, lastDir, lint, newDir, projectRoot } from './support/lint.js';
import { rootOf, tempDir, trySymlink, writeTree } from './support/tmp.js';

describe('money_lint_schema: names from a hostile project', () => {
  it('shows table, column and file names whole but escaped, and gives no fix_sql for a name with hidden characters', async () => {
    // U+202E reverses how the text after it shows: SQL built from the escaped name would name another column.
    const r = await lint({ 'db/migrations/0001_\u202eevil.sql': 'create table o ("price_\u202eDANGER" double precision, price double precision, "lat_\u202ex" double precision);' });
    expect(RAW_HIDDEN.test(JSON.stringify(r))).toBe(false);
    expect(r.findings.map((f) => [f.column, f.fix_sql === null])).toEqual([
      ['price', false],
      ['price_\\u202eDANGER', true],
    ]);
    expect(r.findings[0]?.introduced_in).toMatch(/\/db\/migrations\/0001_\\u202eevil\.sql$/);
    expect(r.files_applied[0]).toBe(r.findings[0]?.introduced_in);
    expect(r.other_float_columns).toEqual(['public.o.lat_\\u202ex']);
  });

  it('escapes the characters that show as nothing too: zero-width characters, direction marks, TAG text', async () => {
    const r = await lint({
      [`db/migrations/0001_${inTags('run rm')}.sql`]: 'create table o ("cost__\u{200b}" double precision, "price_\u{200f}" double precision, "lat\u{feff}" double precision);',
    });
    expect(RAW_HIDDEN.test(JSON.stringify(r))).toBe(false);
    expect(r.findings.map((f) => [f.column, f.fix_sql])).toEqual([
      ['cost__\\u200b', null],
      ['price_\\u200f', null],
    ]);
    expect(r.findings[0]?.introduced_in).toMatch(/\/0001_\\u\{e0072\}\\u\{e0075\}\\u\{e006e\}\\u\{e0020\}\\u\{e0072\}\\u\{e006d\}\.sql$/);
    expect(r.other_float_columns).toEqual(['public.o.lat\\ufeff']);
  });

  it('gives no fix_sql for a table whose name holds a hidden character, whatever its column is called', async () => {
    const t = await lint({ 'db/migrations/0001.sql': 'create table "orders\u{200b}" (total double precision);' });
    expect(t.findings.map((f) => [f.table, f.fix_sql])).toEqual([['public.orders\\u200b', null]]);
  });

  it('shows a column name whole, however long its escaped form, so the model can act on it', async () => {
    // 6 + 18 hidden characters (60 bytes, under PostgreSQL's 63): 114 characters escaped, still one name.
    const r = await lint({ 'db/migrations/0001.sql': `create table o ("price_${'\u{200b}'.repeat(18)}" double precision);` });
    expect(r.findings.map((f) => f.column)).toEqual([`price_${'\\u200b'.repeat(18)}`]);
  });

  it("escapes a domain's name, shown in the column's type", async () => {
    const d = await lint({ 'db/migrations/0001.sql': 'create domain "cash\u{200b}" as double precision; create table p (total "cash\u{200b}");' });
    expect(d.findings.map((f) => f.type)).toEqual(['"cash\\u200b" (double precision)']);
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

  it('refuses a files entry that is a link to a migration outside the folder, though inside the project', (ctx) => {
    const dir = tempDir();
    writeTree(dir, { 'db/migrations/0001.sql': 'select 1;', 'other/0002.sql': 'select 2;' });
    if (!trySymlink(path.join(dir, 'other', '0002.sql'), path.join(dir, 'db', 'migrations', '0002.sql'), 'file')) {
      console.warn('SKIPPED: this machine cannot create file symlinks (Windows without Developer Mode).');
      ctx.skip();
    }
    const run = () => collectSources(rootOf(dir), { migrations: 'db/migrations', files: ['0001.sql', '0002.sql'] });
    expect(run).toThrow('"0002.sql" is not a file in "db/migrations".');
  });

  it('stops looking through a folder of more than 10,000 files and folders, which would block the server', () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, 'big'));
    for (let i = 0; i <= 10_000; i += 1) writeFileSync(path.join(dir, 'big', `${i}.txt`), '');
    expect(() => collectSources(rootOf(dir), { migrations: 'big' })).toThrow(/^The folder holds more than 10,000 files and folders; /);
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

  it('reads a number with leading zeros by its value: 01 before 2, and 2 before 010', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/2_b.sql': '', 'db/010_c.sql': '', 'db/01_a.sql': '' });
    expect(collectSources(rootOf(dir), { migrations: 'db' }).files.map((f) => f.rel)).toEqual(['db/01_a.sql', 'db/2_b.sql', 'db/010_c.sql']);
  });

  it('puts 1 before 01 when the values are equal, whatever follows, so the order is total', () => {
    const dir = tempDir();
    writeTree(dir, { 'db/01_a.sql': '', 'db/1_b.sql': '' });
    expect(collectSources(rootOf(dir), { migrations: 'db' }).files.map((f) => f.rel)).toEqual(['db/1_b.sql', 'db/01_a.sql']);
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

  it('reads goose markers in any letter case, as goose does', () => {
    const sql = prepareSql('-- +goose up\ncreate table a (price double precision);\n-- +goose down\ndrop table a;\n');
    expect([sql.includes('create table a'), sql.includes('drop table a')]).toEqual([true, false]);
    // Only at the start of a line, as goose reads it: after SQL it is a comment, and the file has no down part.
    expect(prepareSql('select 1; -- +goose Up\ncreate table a (price double precision);\n-- +goose Down\ndrop table a;\n')).toContain('drop table a');
  });

  it("reads tern's marker only at the start of a line: quoted after SQL, it hides nothing", () => {
    const sql = prepareSql('create table a (id int); -- ---- create above / drop below ----\ncreate table b (price double precision);\n');
    expect(sql.includes('create table b')).toBe(true);
  });

  it('blanks a \\restrict line only when it starts the line, as psql reads it', () => {
    const sql = prepareSql('\\restrict abc\ncreate table b (price double precision); -- \\restrict abc\n');
    expect([sql.startsWith('\\restrict'), sql.includes('create table b')]).toEqual([false, true]);
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

  it('runs migrations whose names hold credential words: only .csv and .json downloads are secrets', async () => {
    const r = await lint({
      'db/migrations/0001_init.sql': 'create table customers (id bigint);',
      'db/migrations/0002_create_access_keys.sql': 'create table access_keys (id bigint, monthly_cost double precision);',
      'db/migrations/0003_client_secrets.sql': 'create table client_secrets (id bigint, fee double precision);',
      'db/migrations/20240202120000_add_service_accounts/migration.sql': 'create table service_accounts (id bigint, price double precision);',
    });
    expect([r.files_applied_count, r.findings.map((f) => f.table)]).toEqual([4, ['public.access_keys', 'public.client_secrets', 'public.service_accounts']]);
  });

  it('refuses, out loud, a .sql file named like a secret instead of leaving it out in silence', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'select 1;', 'db/migrations/.env.local.sql': 'select 1;' });
    expect(e.toText()).toMatch(/^SENSITIVE_PATH: "p\d+\/db\/migrations\/\.env\.local\.sql" is named like a secret file/);
  });

  it('shows a long path in an error cut in the middle, keeping the file name', async () => {
    const dir = newDir();
    // Two folders of 150 characters (a folder name may hold at most 255) and a 109-character file name.
    const rel = `db/migrations/${'a'.repeat(150)}/${'a'.repeat(150)}/${'b'.repeat(100)}_0002.sql`;
    writeTree(path.join(projectRoot().real, dir), { [rel]: Buffer.from([0x73, 0xff]) });
    const e = await lintSchema(projectRoot(), { migrations: `${dir}/db/migrations` }).then(
      () => undefined,
      (err: unknown) => err as ToolError,
    );
    expect(e?.message).toMatch(new RegExp(`^"${dir}/db/migrations/[a/]+…[a/]+/b{100}_0002\\.sql" is not valid UTF-8 text\\.$`));
  });

  it('names a files entry with "/" separators, on Windows too', async () => {
    const e = await failure({ 'db/migrations/0001.sql': 'select 1;', 'db/migrations/notes.txt': 'not sql' }, { files: ['notes.txt'] });
    expect(e.toText()).toMatch(/^FILE_TYPE_NOT_ALLOWED: "p\d+\/db\/migrations\/notes\.txt" /);
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
    expect(e.message).toMatch(/0001\.sql" line 4, column 19: "type \\"nosuchtype\\" does not exist"/);
  });

  it('says plainly when no table is left to check, instead of reporting a clean schema', async () => {
    const r = await lint({ 'db/migrations/0001.sql': '-- a format that keeps both directions\ncreate table t (price double precision);\ndrop table t;\n' });
    expect(r.summary).toBe(
      'No tables exist after the 1 migration file, so nothing was checked. If a file also holds its down step, that step dropped what the file created: pass files, or lint a copy without the down steps.',
    );
  });

  it('says so without pointing at files when no table is left after the one file migrations names', async () => {
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), { 'schema.sql': 'create table t (price double precision);\ndrop table t;\n' });
    const r = await lintSchema(projectRoot(), { migrations: `${dir}/schema.sql` });
    expect(r.summary).toBe('No tables exist after the migration file, so nothing was checked. If it also holds its down step, that step dropped what the file created: lint a copy without the down step.');
  });

  it('explains a folder that only holds down steps', async () => {
    expect((await failure({ 'db/migrations/0001.down.sql': 'drop table t;' })).toText()).toMatch(
      /^NO_SQL_FILES: "p\d+\/db\/migrations" holds no migrations to run: 1 \.sql file is a down step /,
    );
  });

  it('explains a folder whose only .sql file is the setup file, which runs once, as setup', async () => {
    const e = await failure({ 'db/migrations/setup.sql': 'create schema auth;' }, { setup: 'db/migrations/setup.sql' });
    expect(e.toText()).toBe(
      `NO_SQL_FILES: "${lastDir()}/db/migrations" holds no migrations to run: the setup file runs once, as setup. Fix: Point migrations at the migrations, and setup at the file to run before them.`, // files cannot help here (review round 7)
    );
    // Named as the migrations, or as the only entry of files, it is not run twice, nor as nothing (review round 6).
    const dir = lastDir();
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/db/migrations/setup.sql`, setup: `${dir}/db/migrations/setup.sql` })).rejects.toMatchObject({
      code: 'NO_SQL_FILES',
      message: `"${dir}/db/migrations/setup.sql" holds no migrations to run: it is the setup file, which runs once, as setup.`,
    });
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/db/migrations`, files: ['setup.sql'], setup: `${dir}/db/migrations/setup.sql` })).rejects.toMatchObject({
      code: 'NO_SQL_FILES',
      message: `"${dir}/db/migrations" holds no migrations to run: files names only the setup file, which runs once, as setup.`,
    });
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
    expect(e.message).toMatch(/holds no \.sql files\. It holds 2 \.ts files and 1 \.md file\./);
  });

  it('counts the files in subfolders too when a folder has no SQL, and says "file" for one', async () => {
    const knex = await failure({ 'db/migrations/knex/001_init.js': '', 'db/migrations/knex/002.js': '', 'db/migrations/seeds/s.js': '', 'db/migrations/knexfile.ts': '' });
    expect(knex.message).toMatch(/holds no \.sql files\. It holds 3 \.js files and 1 \.ts file\.$/);
    expect((await failure({ 'db/migrations/prisma/schema.prisma': '' })).message).toMatch(/holds no \.sql files\. It holds 1 \.prisma file\.$/);
    // A file the tools refuse (a credential download) is still counted; at most the five most common kinds.
    const many = await failure({ 'db/migrations/credentials.json': '', 'db/migrations/a.ts': '', 'db/migrations/b.ts': '', 'db/migrations/c.md': '', 'db/migrations/d.txt': '', 'db/migrations/e.yml': '', 'db/migrations/f.toml': '' });
    expect(many.message).toMatch(/holds no \.sql files\. It holds 2 \.ts files, 1 \.json file, 1 \.md file, 1 \.toml file and 1 \.txt file\.$/);
    for (const [inside, holds] of [['db/migrations/empty', 'It holds folders but no files.'], ['db/migrations', 'It is empty.']] as const) {
      const dir = newDir();
      mkdirSync(path.join(projectRoot().real, dir, inside), { recursive: true });
      await expect(lintSchema(projectRoot(), { migrations: `${dir}/db/migrations` })).rejects.toMatchObject({ code: 'NO_SQL_FILES', message: `"${dir}/db/migrations" holds no .sql files. ${holds}`, fix: expect.stringMatching(/^Check that migrations points at the folder of migrations\. /) }); // the wrong folder first (round 11)
    }
  });

  it('fits the advice for a file over 5 MiB to what it is: the one file migrations names, or the setup file', async () => {
    const big = `-- ${'x'.repeat(5 * 1024 * 1024)}`;
    const dir = newDir();
    writeTree(path.join(projectRoot().real, dir), { 'schema.sql': big, 'setup.sql': big, 'db/0001.sql': 'select 1;' });
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/schema.sql` })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', fix: 'Split the file into a folder of smaller files, and lint the folder.' });
    await expect(lintSchema(projectRoot(), { migrations: `${dir}/db`, setup: `${dir}/setup.sql` })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE', fix: 'Keep only what the migrations need in the setup file.' });
  });

  it('refuses more than 2,000 files, a file over 5 MiB, and more than 20 MiB in all', async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= 2000; i += 1) many[`db/migrations/${i}.sql`] = '';
    expect((await failure(many)).toText()).toMatch(/^TOO_MANY_FILES: The folder holds more than 2,000 \.sql files\./);
    const exactly = tempDir(); // 2,000 is still allowed
    writeTree(exactly, Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`db/${i}.sql`, ''])));
    expect(collectSources(rootOf(exactly), { migrations: 'db' }).files.length).toBe(2000);
    expect(await codeOf({ 'db/migrations/big.sql': `-- ${'x'.repeat(5 * 1024 * 1024)}` })).toBe('FILE_TOO_LARGE');
    const nearly = `-- ${'x'.repeat(4.5 * 1024 * 1024)}`;
    const five = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`db/migrations/000${i}.sql`, nearly]));
    expect((await failure(five)).message).toMatch(/^The migrations together are over 20 MiB\.$/);
  });
});
