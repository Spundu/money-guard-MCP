// The lint's database thread (src/lint/database.ts, SPEC.md §3.4, §3.9): its output kept off the
// protocol channel, error positions and hints, and the limits that stop a database that hangs, answers
// wrongly, runs forever, cannot start or outgrows its memory.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../src/errors.js';
import { failure, locate, runScripts } from '../src/lint/database.js';
import { trace } from '../src/server.js';
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
  const fix = (text: string, err: { message: string; code?: string; position?: string }) =>
    failure({ name: 'db/0001.sql', text, phase: 'migration' }, err, context).toText().replace(/^.*? Fix: /s, '');

  it('fits the hint to the error', () => {
    const dump = 'CREATE TABLE public.t (a integer);\nCOPY public.t (a) FROM stdin;\n1\n\\.\n';
    expect(fix(dump, { message: 'syntax error at or near "1"', code: '42601', position: String(dump.indexOf('\n1\n') + 2) })).toMatch(/^The file holds table data after COPY \.\.\. FROM stdin \(a pg_dump with data\)/);
    expect(fix('alter type s add value \'b\';', { message: 'unsafe use of new value "b" of enum type s', code: '55P04' })).toMatch(/a new enum value cannot be used in the transaction that adds it/);
    expect(fix('select 1;', { message: 'out of memory', code: '53200' })).toMatch(/^The file needs more than the lint database can give it/);
    expect(fix('select 1;', { message: 'stack depth limit exceeded', code: '54001' })).toMatch(/^The file needs more than the lint database can give it/);
    expect(fix('create extension pg_net;', { message: 'extension "pg_net" is not available', code: '0A000' })).toMatch(/It has: citext, pgcrypto\. .* lint the migrations folder instead \(supabase\/migrations for Supabase\)\.$/);
    expect(fix('select x;', { message: 'column "x" does not exist', code: '42703' })).toMatch(/^If this file runs on your real database/);
  });
});

describe('runScripts with a database that misbehaves', () => {
  const FAKE = new URL('./support/fake-worker.mjs', import.meta.url);
  const script = { name: 'db/0001.sql', text: 'select 1;', phase: 'migration' as const };
  const run = (mode: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
    process.env.MONEY_GUARD_TEST_WORKER = mode;
    return runScripts([script], { timeoutMs: options.timeoutMs ?? 30_000, preset: false, signal: options.signal, worker: FAKE });
  };

  it('fails the file when the database stops answering after it, within 5 seconds', async () => {
    const started = performance.now();
    await expect(run('silent')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: after this file the database stopped answering (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
    });
    expect(performance.now() - started).toBeLessThan(8000);
  });

  it('fails the file when the database answers wrongly after it', async () => {
    await expect(run('unusable')).rejects.toMatchObject({
      code: 'MIGRATION_FAILED',
      message: 'db/0001.sql: after this file the database no longer answers correctly (a statement PGlite cannot carry out, such as COPY ... PROGRAM).',
    });
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
    const running = run('endless', how === 'the time limit' ? { timeoutMs: 400 } : { signal: controller.signal });
    if (how === 'cancellation') setTimeout(() => controller.abort(new Error('cancelled')), 400);
    await expect(running).rejects.toBeDefined();
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
