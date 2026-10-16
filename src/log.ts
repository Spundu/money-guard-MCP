// The server's log (stderr, SPEC.md §2.1) never blocks the server. On Windows, Node writes to a pipe
// synchronously (process.stderr.write waits until the host reads), so a host that pipes stderr but never
// reads it would freeze the event loop once the pipe is full. Lines go out one at a time through
// fs.write, on libuv's thread pool; while a write waits, at most MAX_WAITING lines queue up and later
// ones are dropped. A write that fails (a closed stderr, or a full one where writes do not wait) is
// dropped too: lost log lines are fine, a stuck server is not.

import { write } from 'node:fs';

const MAX_WAITING = 100;
const waiting: string[] = [];
let writing = false;

function next(): void {
  const line = waiting.shift();
  writing = line !== undefined;
  if (line !== undefined) write(2, line, () => next());
}

/**
 * Whether a line is being written. On Windows such a write may wait for good on a host that never reads
 * stderr, and process.exit waits for it (review round 20): the caller then ends the process another way.
 */
export function logWriting(): boolean {
  return writing;
}

/** Write one line to stderr without ever blocking. */
export function logLine(line: string): void {
  if (waiting.length >= MAX_WAITING) return;
  waiting.push(`${line}\n`);
  if (!writing) next();
}
