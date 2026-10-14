// money_lint_schema (SPEC.md §3): failures and their hints, platforms (Supabase, setup, pgvector) and
// safety (time limits, cancellation, BUSY). Which files run is in lint-files.test.ts.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintSchema } from '../src/lint/run.js';
import { SPEC_FILES, codeOf, failure, lastDir, lint, newDir, projectRoot } from './support/lint.js';
import { tempDir, writeTree } from './support/tmp.js';

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
      [{ 'db/migrations/0001.sql': "create table t (id uuid, user_id text);\nselect * from t where id = user_id;" }, '42883', /^The two sides of an operator have types that do not go together/],
      [{ 'db/migrations/0001.sql': 'create table t (id int);\nvacuum t;' }, '25001', /^money-guard runs each file as one script, where VACUUM cannot run/],
      [{ 'db/migrations/0001.sql': 'create table t (price double precision);\ncreate view v as select price from t;\nalter table t alter column price type bigint;' }, '0A000', /^Something else uses this column \(a view, a rule/],
    ];
    for (const [files, state, hint] of cases) {
      const e = await failure(files);
      expect(e.message, state).toContain(`(SQLSTATE ${state})`);
      expect(e.fix, state).toMatch(hint);
    }
  });

  it('says the files ran in the order files gave, when files gave it', async () => {
    const e = await failure({ 'db/migrations/a.sql': 'create table b2 as select * from b1;', 'db/migrations/b.sql': 'create table b1 (id int);' }, { files: ['a.sql', 'b.sql'] });
    expect(e.fix).toMatch(/^If one of your migrations creates it, the files ran out of order: the files ran in the order files gives; put the file that creates it first\./);
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
    expect(e.fix).toBe('Leave slow data-loading files out with files. A larger timeout_seconds (at most 300) helps only with a client that waits longer than 60 seconds for an answer.');
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
