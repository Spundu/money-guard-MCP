import process from 'node:process';
import { describe, expect, it, vi } from 'vitest';
import { failure, locate, runScripts } from '../src/lint/database.js';

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
