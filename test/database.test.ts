// The lint's database thread (src/lint/database.ts, SPEC.md §3.4, §3.9): its output kept off the
// protocol channel, error positions and hints, and the limits that stop a database that hangs, answers
// wrongly, runs forever, cannot start or outgrows its memory.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../src/errors.js';
import { failure, locate } from '../src/lint/advice.js';
import { runScripts } from '../src/lint/database.js';
import { trace } from '../src/server.js';
import { lintWhileTaking } from './support/memory.js';
import { tempDir } from './support/tmp.js';

describe('runScripts', () => {
  it("keeps everything the database thread writes out of the server's stdout and stderr", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      const outcome = await runScripts([], { timeoutMs: 30_000, preset: false, worker: new URL('./support/noisy-worker.mjs', import.meta.url) });
      expect(outcome.postgres).toBe('PostgreSQL 0 (fake)');
      await new Promise((r) => setTimeout(r, 300)); // piped worker output arrives asynchronously
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    expect(written.filter((w) => w.includes('LEAK'))).toEqual([]);
  });
});

describe('locate', () => {
  it('turns a 1-based character position into a line and column, counting code points', () => {
    expect(locate('select x', 8)).toEqual({ line: 1, column: 8 });
    expect(locate('a\nbc\nd', 4)).toEqual({ line: 2, column: 2 });
    expect(locate('😀\nab', 4)).toEqual({ line: 2, column: 2 });
  });
});

describe('failure', () => {
  const context = { available: ['citext', 'pgcrypto'], preset: false };
  const fix = (text: string, err: { message: string; code?: string; position?: string; hint?: string }) =>
    failure({ name: 'db/0001.sql', text, phase: 'migration' }, err, context).toText().replace(/^.*? Fix: /s, '');

  it('fits the hint to the error', () => {
    expect(fix('create table t1 (id int);', { message: 'out of shared memory', code: '53200', hint: 'You might need to increase "max_locks_per_transaction".' })).toMatch(/^The file creates more objects than one transaction can hold locks for/);
    expect(fix('create tabel b (id int);', { message: 'syntax error at or near "tabel"', code: '42601', position: '8' })).toBe('Fix the SQL at that place: PostgreSQL could not read it as written.');
    const dump = 'CREATE TABLE public.t (a integer);\nCOPY public.t (a) FROM stdin;\n1\n\\.\n';
    expect(fix(dump, { message: 'syntax error at or near "1"', code: '42601', position: String(dump.indexOf('\n1\n') + 2) })).toMatch(/^The file holds table data after COPY \.\.\. FROM stdin \(a pg_dump with data\)/);
    expect(fix('alter type s add value \'b\';', { message: 'unsafe use of new value "b" of enum type s', code: '55P04' })).toMatch(/a new enum value cannot be used in the transaction that adds it/);
    expect(fix('select 1;', { message: 'out of memory', code: '53200' })).toMatch(/^The file needs more than the lint database can give it/);
    expect(fix('select 1;', { message: 'stack depth limit exceeded', code: '54001' })).toMatch(/^The file needs more than the lint database can give it/);
    expect(fix('create extension pg_net;', { message: 'extension "pg_net" is not available', code: '0A000' })).toMatch(/It has: citext, pgcrypto\. .* lint the migrations folder instead \(supabase\/migrations for Supabase\)\.$/);
    expect(fix('select x;', { message: 'column "x" does not exist', code: '42703' })).toMatch(/^If this file runs on your real database/);
  });

  it('gives the setup file advice for the setup file: it is not one of the migrations, so files cannot leave it out', () => {
    const setup = (text: string, err: { message: string; code?: string; position?: string }) => failure({ name: 'setup.sql', text, phase: 'setup' }, err, context);
    const errors: Array<[string, { message: string; code?: string; position?: string }]> = [
      ['create extension pg_net;', { message: 'extension "pg_net" is not available', code: '0A000' }],
      ['create table x (a uuid references auth.users);', { message: 'relation "auth.users" does not exist', code: '42P01' }],
      ['\\connect other\n', { message: 'syntax error at or near "\\"', code: '42601', position: '1' }],
      ['create index concurrently i on t (a);', { message: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block', code: '25001' }],
      ["alter type s add value 'b';", { message: 'unsafe use of new value "b" of enum type s', code: '55P04' }],
      ['select 1;', { message: 'out of memory', code: '53200' }],
      ['select x;', { message: 'column "x" does not exist', code: '42703' }],
    ];
    for (const [text, err] of errors) {
      const e = setup(text, err);
      expect(e.code, err.message).toBe('SETUP_FAILED');
      expect(e.fix, err.message).toMatch(/setup file/);
      expect(e.fix, err.message).not.toMatch(/with files|ran out of order|pass setup/);
    }
    expect(setup('select x;', { message: 'column "x" does not exist', code: '42703' }).fix).toBe('Fix the setup file at that place.');
  });

  it('never says to use files when migrations is one file, which files cannot pick from', () => {
    const single = (text: string, err: { message: string; code?: string; position?: string }) => failure({ name: 'schema.sql', text, phase: 'migration' }, err, { ...context, single: true }).fix;
    const fixes = [
      single('create extension pg_net;', { message: 'extension "pg_net" is not available', code: '0A000' }),
      single('create table x (a uuid references auth.users);', { message: 'relation "auth.users" does not exist', code: '42P01' }),
      single('\\connect other\n', { message: 'syntax error at or near "\\"', code: '42601', position: '1' }),
      single('create index concurrently i on t (a);', { message: 'CREATE INDEX CONCURRENTLY cannot run inside a transaction block', code: '25001' }),
      single("alter type s add value 'b';", { message: 'unsafe use of new value "b" of enum type s', code: '55P04' }),
      single('select 1;', { message: 'out of memory', code: '53200' }),
    ];
    for (const fix of fixes) expect(fix).not.toMatch(/with files|pass files|out of order/);
    expect(fixes[0]).toContain('If the file uses it for something unrelated to money, lint a copy of the file without that part.');
    expect(fixes[1]).toMatch(/^This file needs objects your platform creates\./);
    expect(fixes[2]).toMatch(/Lint a copy without that line\.$/);
    expect(fixes[3]).toMatch(/Lint a copy without it\.$/);
    expect(fixes[4]).toMatch(/Split the file in two, put both in a folder, and lint the folder\.$/);
    expect(fixes[5]).toMatch(/Lint a copy without the part that needs it \(a large data load, say\)\.$/);
  });
});

describe('runScripts with a setup file that goes wrong', () => {
  const setup = (text: string) => ({ name: 'setup.sql', text, phase: 'setup' as const });
  const migration = { name: 'db/0001.sql', text: 'select 1;', phase: 'migration' as const };

  it('fails the setup file, not a migration, when it leaves the database unusable', async () => {
    await expect(runScripts([setup("copy (select 1) to program 'true';"), migration], { timeoutMs: 30_000, preset: false })).rejects.toMatchObject({
      code: 'SETUP_FAILED',
      message: 'setup.sql: after this file the database no longer answers correctly (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
      fix: 'Take that statement out of the setup file.',
    });
  });

  it('fails the setup file, not a migration, when the database stops answering after it', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'silent';
    try {
      await expect(runScripts([setup('select 1;'), migration], { timeoutMs: 30_000, preset: false, worker: new URL('./support/fake-worker.mjs', import.meta.url), sanityMs: 100 })).rejects.toMatchObject({
        code: 'SETUP_FAILED',
        message: 'setup.sql: after this file the database stopped answering (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
        fix: 'Take that statement out of the setup file.',
      });
    } finally {
      delete process.env.MONEY_GUARD_TEST_WORKER;
    }
  });

  it('fails the setup file, not a migration, when the database thread dies while it runs', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'crash';
    try {
      await expect(runScripts([setup('select 1;'), migration], { timeoutMs: 30_000, preset: false, worker: new URL('./support/fake-worker.mjs', import.meta.url) })).rejects.toMatchObject({
        code: 'SETUP_FAILED',
        message: 'setup.sql: the database stopped while running this file (the database thread died).',
        fix: 'Take the statement that stops the database out of the setup file.',
      });
    } finally {
      delete process.env.MONEY_GUARD_TEST_WORKER;
    }
  });

  it('fails the setup file, not a migration, when it outgrows the memory limit', async () => {
    const big = setup('create table big (b text); insert into big select repeat(md5(i::text), 30) from generate_series(1, 400000) i;');
    await expect(runScripts([big, migration], { timeoutMs: 60_000, preset: false, memoryLimitBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({
      code: 'SETUP_FAILED',
      message: 'setup.sql: the lint database grew by more than 64 MiB of memory while running this file.',
      fix: 'The file needs more than the lint database can give it (memory or a size limit). Take that part out of the setup file.',
    });
  });
});

describe('runScripts with a database that misbehaves', () => {
  const FAKE = new URL('./support/fake-worker.mjs', import.meta.url);
  const script = { name: 'db/0001.sql', text: 'select 1;', phase: 'migration' as const };
  afterEach(() => {
    delete process.env.MONEY_GUARD_TEST_WORKER;
    delete process.env.MONEY_GUARD_TEST_HEARTBEAT;
  });

  it('stops at once, running nothing, when the call was cancelled before it started', async () => {
    await expect(runScripts([script], { timeoutMs: 30_000, preset: false, signal: AbortSignal.abort(new Error('cancelled first')) })).rejects.toThrow('cancelled first');
  });
  const run = (mode: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
    process.env.MONEY_GUARD_TEST_WORKER = mode;
    return runScripts([script], { timeoutMs: options.timeoutMs ?? 30_000, preset: false, signal: options.signal, worker: FAKE });
  };

  it('fails the file when the database stops answering after it, 5 seconds after it ran', async () => {
    const started = performance.now();
    await expect(run('silent')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: after this file the database stopped answering (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
    });
    const ms = performance.now() - started;
    expect(ms).toBeGreaterThanOrEqual(4900); // not sooner: a database that is slow to answer is not stuck
    expect(ms).toBeLessThan(8000);
  });

  it('waits for an answer that came while the server was busy, before calling the database silent', async () => {
    // A ledger or audit call can keep the server's thread busy past the 5-second check while the
    // database's answer waits in the queue. Here the thread is blocked right after the file ran, until
    // the check's time has passed and the answer (sent 500 ms after the file ran) has come; the run
    // ends a second later.
    const sanityMs = 100;
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      if (ms === sanityMs) {
        setImmediate(() => {
          const until = performance.now() + 1000;
          while (performance.now() < until) {
            // busy, as a long ledger call is
          }
        });
      }
      return realSetTimeout(callback, ms);
    }) as unknown as typeof setTimeout);
    process.env.MONEY_GUARD_TEST_WORKER = 'late';
    try {
      await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE, sanityMs })).resolves.toMatchObject({ postgres: 'PostgreSQL 0 (fake)' });
    } finally {
      spy.mockRestore();
    }
  });

  it('does not count memory that the server thread takes meanwhile (a ledger or audit call) against the lint', async () => {
    const MIB = 1024 * 1024;
    const { answer, held } = await lintWhileTaking(() => Buffer.alloc(256 * MIB, 1), 64 * MIB); // as an audit call holds the file it reads
    expect(answer).toBe('PostgreSQL 0 (fake)');
    expect(held.byteLength).toBe(256 * MIB); // held until the lint ended
  });

  it('fails the file that was running when the database thread died, naming it', async () => {
    await expect(run('crash')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: the database stopped while running this file (the database thread died).',
    });
  });

  it.skipIf(!('getHeapStatistics' in Worker.prototype))('does not count memory the server thread freed but the system kept against the lint (Node.js 22.16+)', async () => {
    const MIB = 1024 * 1024;
    const started = path.join(tempDir(), 'started');
    process.env.MONEY_GUARD_TEST_HEARTBEAT = started;
    process.env.MONEY_GUARD_TEST_WORKER = 'slow';
    const outcome = runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE, memoryLimitBytes: 64 * MIB }).then(
      (ok) => ({ ok }),
      (error: unknown) => ({ error }),
    );
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100)); // the database has started: the memory baseline is taken
    // A ledger call has freed 3 GiB that the system keeps: the process is big, its JavaScript small again.
    const real = process.memoryUsage();
    const spy = vi.spyOn(process, 'memoryUsage').mockReturnValue({ ...real, rss: real.rss + 3 * 1024 * MIB });
    try {
      await new Promise((r) => setTimeout(r, 500)); // five memory checks
      writeFileSync(`${started}.go`, '');
      expect(await outcome).toMatchObject({ ok: { postgres: 'PostgreSQL 0 (fake)' } });
    } finally {
      spy.mockRestore();
    }
  });

  it('fails the file when the database answers wrongly after it', async () => {
    await expect(run('unusable')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: after this file the database no longer answers correctly (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
    });
  });

  it('says when time ran out or the thread died while the catalog was read, after every file had run', async () => {
    await expect(run('reading', { timeoutMs: 3000 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'The lint ran out of time (3 s) while reading the catalog, after every file had run.',
      fix: 'timeout_seconds may be up to 300, but a limit over 60 seconds helps only with a client that waits longer than that for an answer.',
    });
    await expect(run('reading-crash')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: the catalog could not be read after this file, the last one (the database thread died).',
      fix: "Leave the file out with files, or lint it on its own to find the statement that breaks the read (one that replaces PostgreSQL's own functions, say).",
    });
  });

  it('says when the memory limit was hit while the catalog was read, after every file had run', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'reading-grows';
    // 256 MiB against 192 MiB: a limit applied loosely (twice over, say) would let it pass.
    await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE, memoryLimitBytes: 192 * 1024 * 1024 })).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: the lint database grew by more than 192 MiB of memory while reading the catalog after this file, the last one.',
    });
  });

  it('says what was running when time ran out: the start of the database, or the setup file', async () => {
    process.env.MONEY_GUARD_TEST_HEARTBEAT = path.join(tempDir(), 'beat');
    await expect(run('endless', { timeoutMs: 3000 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'The lint ran out of time (3 s) while starting the database.',
      fix: 'timeout_seconds may be up to 300, but a limit over 60 seconds helps only with a client that waits longer than that for an answer.',
    });
    process.env.MONEY_GUARD_TEST_WORKER = 'hang';
    await expect(runScripts([{ name: 'setup.sql', text: 'select 1;', phase: 'setup' }], { timeoutMs: 3000, preset: false, worker: FAKE })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'The lint ran out of time (3 s) while running setup.sql.',
      fix: 'Take slow data loading out of the setup file. timeout_seconds may be up to 300, but a limit over 60 seconds helps only with a client that waits longer than that for an answer.',
    });
  });

  it('says, when time runs out in a folder of hundreds of files, that the folder is large, not that a file is slow', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'hang';
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `db/${String(i).padStart(4, '0')}.sql`, text: 'select 1;', phase: 'migration' as const }));
    await expect(runScripts(many, { timeoutMs: 2000, preset: false, worker: FAKE })).rejects.toMatchObject({
      code: 'TIMEOUT',
      fix: expect.stringMatching(/^The folder holds 300 migration files, each run and checked in turn: pass a larger timeout_seconds, or lint one schema-only dump of the database they build \(pg_dump --schema-only\)\./),
    });
  });

  it('counts only migration files for that, not the setup file', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'hang-second';
    const setup = { name: 'setup.sql', text: 'select 1;', phase: 'setup' as const };
    const many = Array.from({ length: 299 }, (_, i) => ({ name: `db/${String(i).padStart(4, '0')}.sql`, text: 'select 1;', phase: 'migration' as const }));
    await expect(runScripts([setup, ...many], { timeoutMs: 2000, preset: false, worker: FAKE })).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'The lint ran out of time (2 s) while running db/0000.sql.',
      fix: expect.stringMatching(/^Leave slow data-loading files out with files\. /),
    });
  });

  it('never says to use files when migrations is one file, which files cannot pick from', async () => {
    const fixOf = (mode: string, timeoutMs = 30_000) => {
      process.env.MONEY_GUARD_TEST_WORKER = mode;
      return runScripts([script], { timeoutMs, preset: false, single: true, worker: FAKE }).then(
        () => 'no error',
        (e: unknown) => (e instanceof ToolError ? e.fix : String(e)),
      );
    };
    // Review round 8: every file had run, so data loading is not what took the time.
    expect(await fixOf('reading', 3000)).toBe('timeout_seconds may be up to 300, but a limit over 60 seconds helps only with a client that waits longer than that for an answer.');
    expect(await fixOf('unusable')).toBe('Lint a copy without that statement.');
    expect(await fixOf('crash')).toBe('Lint parts of the file on their own to find the statement that stops the database.');
    expect(await fixOf('reading-crash')).toBe("Lint parts of the file on their own to find the statement that breaks the read (one that replaces PostgreSQL's own functions, say).");
  });

  it('treats a database that cannot start as a failure of money-guard: no detail for the model, the cause for the log', async () => {
    const err: unknown = await run('broken').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolError); // so the server answers INTERNAL_ERROR without detail
    expect((err as Error).name).toBe('DatabaseStartError');
    expect((err as Error).message).not.toContain('Private Clients');
    expect(trace(err)).toMatch(/^DatabaseStartError \| .* <- Error ERR_MODULE_NOT_FOUND/);
    expect(trace(err)).not.toContain('Private Clients');
  });

  it.each(['the time limit', 'cancellation'])('kills the database thread at %s: its heartbeat stops', async (how) => {
    const heartbeat = path.join(tempDir(), 'beat');
    process.env.MONEY_GUARD_TEST_HEARTBEAT = heartbeat;
    const controller = new AbortController();
    const running = run('endless', how === 'the time limit' ? { timeoutMs: 3000 } : { signal: controller.signal });
    const stopped = running.then(
      () => 'resolved',
      () => 'rejected',
    );
    // The thread is alive once it beats; a busy machine can take a while to start it.
    await vi.waitFor(() => expect(existsSync(heartbeat)).toBe(true), { timeout: 10_000 });
    if (how === 'cancellation') controller.abort(new Error('cancelled'));
    expect(await stopped).toBe('rejected');
    await new Promise((r) => setTimeout(r, 200));
    const beat = readFileSync(heartbeat, 'utf8');
    await new Promise((r) => setTimeout(r, 400));
    expect(readFileSync(heartbeat, 'utf8')).toBe(beat);
  });
});

describe('runScripts memory', () => {
  it('stops a file whose data outgrows the memory limit, and names it', async () => {
    // About 400 MB of rows, against a limit of 64 MiB (the real one is 1 GiB). PGlite keeps them in
    // WebAssembly memory and in-memory files, which the worker's heap limit does not cover.
    const seed = {
      name: 'db/0002_seed.sql',
      text: 'create table big (b text); insert into big select repeat(md5(i::text), 30) from generate_series(1, 400000) i;',
      phase: 'migration' as const,
    };
    await expect(runScripts([seed], { timeoutMs: 60_000, preset: false, memoryLimitBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0002_seed.sql: the lint database grew by more than 64 MiB of memory while running this file.',
      fix: expect.stringMatching(/^The file needs more than the lint database can give it/),
    });
  });
});
