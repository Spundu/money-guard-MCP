// A lint run by a stand-in database thread while the server's own thread takes memory, as a ledger or
// audit call does meanwhile: for the tests of the lint's memory watchdog (SPEC.md §3.9).
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { expect, vi } from 'vitest';
import { runScripts } from '../../src/lint/database.js';
import { tempDir } from './tmp.js';

const FAKE = new URL('./fake-worker.mjs', import.meta.url);

/**
 * Starts a lint, lets the database start (the watchdog takes its baseline then), calls `take` on the
 * server's thread, lets five memory checks pass, and lets the lint end. Returns what the lint
 * answered ("PostgreSQL 0 (fake)", or "failed: " and its error) and what `take` returned, which was
 * held until the lint had answered.
 */
export async function lintWhileTaking<T>(take: () => T, memoryLimitBytes: number): Promise<{ answer: string; held: T }> {
  const started = path.join(tempDir(), 'started');
  process.env.MONEY_GUARD_TEST_HEARTBEAT = started;
  process.env.MONEY_GUARD_TEST_WORKER = 'slow';
  try {
    const outcome = runScripts([{ name: 'db/0001.sql', text: 'select 1;', phase: 'migration' }], { timeoutMs: 30_000, preset: false, worker: FAKE, memoryLimitBytes }).then(
      (ok) => ok.postgres,
      (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 10_000 });
    await new Promise((r) => setTimeout(r, 100)); // the database has started: the memory baseline is taken
    const held = take();
    await new Promise((r) => setTimeout(r, 500)); // five memory checks
    writeFileSync(`${started}.go`, '');
    return { answer: await outcome, held };
  } finally {
    delete process.env.MONEY_GUARD_TEST_HEARTBEAT;
    delete process.env.MONEY_GUARD_TEST_WORKER;
  }
}
