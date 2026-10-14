// The server's log (src/log.ts, SPEC.md §2.1): one write at a time, in the background; while a write
// waits, at most 100 lines queue up and later ones are dropped; a write that fails is skipped.
import { describe, expect, it, vi } from 'vitest';
import { logLine } from '../src/log.js';

// stderr as a pipe the test controls: a write finishes only when the test says so.
const stderr = vi.hoisted(() => ({ written: [] as string[], waiting: [] as Array<(err: Error | null) => void> }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  write: (_fd: number, line: string, done: (err: Error | null) => void) => {
    stderr.written.push(line);
    stderr.waiting.push(done);
  },
}));

/** Let every write finish (with `err`), including the ones that finishing starts. */
function drain(err: Error | null = null): void {
  for (let done = stderr.waiting.shift(); done !== undefined; done = stderr.waiting.shift()) done(err);
}

describe('logLine', () => {
  it('writes one line at a time, and keeps at most 100 waiting while stderr is stuck', () => {
    for (let i = 0; i < 150; i += 1) logLine(`line ${i}`);
    expect(stderr.written).toEqual(['line 0\n']); // the first write has not finished: nothing else starts
    drain();
    // The 100 lines that waited went out in order; the 49 after them were dropped.
    expect(stderr.written).toEqual(Array.from({ length: 101 }, (_, i) => `line ${i}\n`));
    logLine('after');
    expect(stderr.written.at(-1)).toBe('after\n');
    drain();
  });

  it('goes on with the next line when a write fails (a closed stderr)', () => {
    stderr.written.length = 0;
    logLine('one');
    logLine('two');
    drain(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    expect(stderr.written).toEqual(['one\n', 'two\n']);
  });
});
