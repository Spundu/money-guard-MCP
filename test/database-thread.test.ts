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

describe('runScripts, waiting for the last database thread to end', () => {
  it('keeps its time limit and its cancel while it waits, so a thread that never ended costs a TIMEOUT, not a hang', async () => {
    let letGo = () => {};
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const terminate = Worker.prototype.terminate;
    const spy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      return held.then(() => terminate.call(this));
    });
    try {
      process.env.MONEY_GUARD_TEST_WORKER = 'unusable';
      await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      // Its thread has not ended (held): the next lints wait, but only as long as their limits allow.
      await expect(runScripts([script], { timeoutMs: 1000, preset: false, worker: FAKE })).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: 'The lint ran out of time (1 s) while starting the database.',
      });
      const controller = new AbortController();
      const waiting = runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE, signal: controller.signal });
      controller.abort(new Error('cancelled while waiting'));
      await expect(waiting).rejects.toThrow('cancelled while waiting');
    } finally {
      letGo();
      spy.mockRestore();
    }
  });
});

describe('runScripts, the time spent waiting and the order kept', () => {
  it('counts the time limit from the call, waiting included, and starts no thread before a held one ends', async () => {
    let letGo = () => {};
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const terminate = Worker.prototype.terminate;
    let first = true;
    const spy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      if (!first) return terminate.call(this);
      first = false;
      return held.then(() => terminate.call(this));
    });
    const started = path.join(tempDir(), 'started');
    try {
      process.env.MONEY_GUARD_TEST_WORKER = 'unusable';
      await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      // Gives up waiting: its place in the queue still ends only when the held thread does.
      await expect(runScripts([script], { timeoutMs: 500, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'TIMEOUT' });
      process.env.MONEY_GUARD_TEST_WORKER = 'slow';
      process.env.MONEY_GUARD_TEST_HEARTBEAT = started;
      const third = runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE });
      await new Promise((r) => setTimeout(r, 1500));
      expect(existsSync(started)).toBe(false); // not started while the first thread is held
      letGo();
      await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 15_000 });
      writeFileSync(`${started}.go`, '');
      await expect(third).resolves.toMatchObject({ postgres: 'PostgreSQL 0 (fake)' });
    } finally {
      letGo();
      spy.mockRestore();
    }
  });

  it('counts the time limit from the call: a lint that waited does not get the whole limit again', async () => {
    let letGo = () => {};
    const held = new Promise<void>((resolve) => (letGo = resolve));
    const terminate = Worker.prototype.terminate;
    let first = true;
    const spy = vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
      if (!first) return terminate.call(this);
      first = false;
      return held.then(() => terminate.call(this));
    });
    try {
      process.env.MONEY_GUARD_TEST_WORKER = 'unusable';
      await expect(runScripts([script], { timeoutMs: 30_000, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
      setTimeout(letGo, 1500); // the next lint waits 1.5 s of its 4 s
      process.env.MONEY_GUARD_TEST_WORKER = 'hang';
      const calledAt = performance.now();
      await expect(runScripts([script], { timeoutMs: 4000, preset: false, worker: FAKE })).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(performance.now() - calledAt).toBeLessThan(5000); // 4 s from the call, not 1.5 + 4
    } finally {
      letGo();
      spy.mockRestore();
    }
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

describe('the check after each file', () => {
  it('reads only the columns the file created or changed, so many files do not each read the whole schema', async () => {
    const snapshots: number[] = [];
    const spy = vi.spyOn(Worker.prototype, 'emit').mockImplementation(function (this: Worker, event: string | symbol, ...args: unknown[]) {
      const m = args[0] as { type: string; rows?: unknown[] };
      if (event === 'message' && m.type === 'snapshot') snapshots.push(m.rows?.length ?? -1);
      return EventEmitter.prototype.emit.call(this, event, ...args);
    });
    try {
      const scripts = [
        { name: 'db/0001.sql', text: 'create table a (x int, y int, z int); create table b (x int, y int, z int);', phase: 'migration' as const },
        { name: 'db/0002.sql', text: 'alter table a alter column y type bigint;', phase: 'migration' as const },
        { name: 'db/0003.sql', text: 'create index on b (x);', phase: 'migration' as const },
      ];
      const outcome = await runScripts(scripts, { timeoutMs: 60_000, preset: false });
      expect([...outcome.since.values()].sort()).toEqual([0, 0, 0, 0, 0, 1]); // y changed in the second file
    } finally {
      spy.mockRestore();
    }
    expect(snapshots).toEqual([6, 1, 0]);
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
  // The database thread's own memory: what the server's thread holds meanwhile (here many small
  // objects and a file's buffer, as a parsed export has) is not the lint's. (Older
  // Node.js measures the process instead: test/database-memory-fallback.test.ts.)
  it.skipIf(!('getHeapStatistics' in Worker.prototype))('does not count the JavaScript objects and buffers the server thread holds against the lint', async () => {
    const { answer, held } = await lintWhileTaking(() => [Array.from({ length: 2_500_000 }, (_, i) => ({ i, text: `row ${i}` })), Buffer.alloc(64 * MIB, 1)] as const, 64 * MIB);
    expect(answer).toBe('PostgreSQL 0 (fake)');
    expect([held[0].length, held[1].byteLength]).toEqual([2_500_000, 64 * MIB]); // about 250 MB of objects, and the buffer
  });
});
