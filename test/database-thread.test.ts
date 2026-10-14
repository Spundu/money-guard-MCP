// The lint's database thread itself (src/lint/database.ts, SPEC.md §3.4, §3.9): one at a time, the
// messages the real one sends, the limits it gets when the caller sets none, and what its memory is.
import { existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_LIMIT_BYTES, runScripts } from '../src/lint/database.js';
import { lintWhileTaking } from './support/memory.js';
import { tempDir } from './support/tmp.js';

const FAKE = new URL('./support/fake-worker.mjs', import.meta.url);
const script = { name: 'db/0001.sql', text: 'select 1;', phase: 'migration' as const };
const MIB = 1024 * 1024;

afterEach(() => {
  delete process.env.MONEY_GUARD_TEST_WORKER;
  delete process.env.MONEY_GUARD_TEST_HEARTBEAT;
});

describe('runScripts, one database thread at a time', () => {
  it('starts a database thread only once the last one has ended, and answers without waiting for that', async () => {
    // On Node.js 24, a thread that starts while another is torn down can make V8 abort the whole
    // process (nodejs/node#66366). Here the first thread takes 2 seconds to end, as on a busy machine.
    const started = path.join(tempDir(), 'started');
    const events: string[] = [];
    let firstEnded: Promise<unknown> | undefined;
    const terminate = Worker.prototype.terminate;
    const spy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      if (firstEnded !== undefined) return terminate.call(this);
      firstEnded = new Promise((resolve) => setTimeout(resolve, 2000))
        .then(() => terminate.call(this))
        .then((code) => {
          events.push(existsSync(started) ? 'ended after the next one started' : 'ended');
          return code;
        });
      return firstEnded as Promise<number>;
    });
    try {
      process.env.MONEY_GUARD_TEST_WORKER = 'unusable';
      await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      events.push('answered');
      process.env.MONEY_GUARD_TEST_WORKER = 'slow';
      process.env.MONEY_GUARD_TEST_HEARTBEAT = started;
      const next = runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE });
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 15_000 });
      writeFileSync(`${started}.go`, '');
      await expect(next).resolves.toMatchObject({ postgres: 'PostgreSQL 0 (fake)' });
      await firstEnded;
    } finally {
      spy.mockRestore();
    }
    expect(events).toEqual(['answered', 'ended']);
  });
});

describe('the real database thread', () => {
  it('says when each file runs, has run and has been read, so the 5-second check follows every file', async () => {
    const types: string[] = [];
    const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      if (event === 'message') types.push((args[0] as { type: string }).type);
      return EventEmitter.prototype.emit.call(this, event, ...args);
    });
    try {
      const scripts = [script, { name: 'db/0002.sql', text: 'create table t (id int);', phase: 'migration' as const }];
      await expect(runScripts(scripts, { timeoutMs: 60_000, preset: false })).resolves.toMatchObject({ postgres: expect.stringMatching(/^PostgreSQL 18/) });
    } finally {
      spy.mockRestore();
    }
    expect(types).toEqual(['ready', 'running', 'executed', 'snapshot', 'running', 'executed', 'snapshot', 'reading', 'done']);
  });
});

describe('the limits a lint gets when the caller sets none (SPEC.md §3.9)', () => {
  it('gives the database thread a JavaScript heap of 1 GiB', async () => {
    process.env.MONEY_GUARD_TEST_WORKER = 'limits';
    await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE })).resolves.toMatchObject({ postgres: 'PostgreSQL 0 (fake; heap limit 1024 MB)' });
  });

  it('lets the lint grow by 1 GiB: 256 MiB more is not stopped', async () => {
    expect(MEMORY_LIMIT_BYTES).toBe(1024 * MIB);
    // The stand-in takes 256 MiB while it reads the catalog, then says nothing more, until cancelled.
    const grown = path.join(tempDir(), 'grown');
    process.env.MONEY_GUARD_TEST_HEARTBEAT = grown;
    process.env.MONEY_GUARD_TEST_WORKER = 'reading-grows';
    const controller = new AbortController();
    const outcome = runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE, signal: controller.signal }).then(
      () => 'answered',
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(existsSync(grown)).toBe(true), { timeout: 15_000 });
    await new Promise((r) => setTimeout(r, 500)); // five memory checks
    controller.abort(new Error('the test is done'));
    expect(await outcome).toMatchObject({ message: 'the test is done' });
  });
});

describe('runScripts memory, measured beside a busy server thread (Node.js 22.16 and later)', () => {
  // The database thread's own memory: what a ledger or audit call holds meanwhile on the server's
  // thread, a parsed export's many small objects and the file's buffer, is not the lint's. (Older
  // Node.js measures the process instead: test/database-memory-fallback.test.ts.)
  it.skipIf(!('getHeapStatistics' in Worker.prototype))('does not count the JavaScript objects and buffers the server thread holds against the lint', async () => {
    const { answer, held } = await lintWhileTaking(() => [Array.from({ length: 2_500_000 }, (_, i) => ({ i, text: `row ${i}` })), Buffer.alloc(64 * MIB, 1)] as const, 64 * MIB);
    expect(answer).toBe('PostgreSQL 0 (fake)');
    expect([held[0].length, held[1].byteLength]).toEqual([2_500_000, 64 * MIB]); // about 250 MB of objects, and the buffer
  });
});
