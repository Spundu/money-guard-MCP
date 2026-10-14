// The lint's memory watchdog on Node.js older than 22.16 (src/lint/database.ts lintMemory, SPEC.md
// §3.9), which cannot measure one thread: the process's memory, less the main thread's JavaScript heap
// and external memory, stands in. Forced here on every Node.js version.
//
// On its own in this file, so in a process of its own: memory the main thread frees during a lint can
// count against it under this measure (on Linux, 200 MiB of small objects freed counted up to 164 MiB),
// and garbage that an earlier test left would be freed during this one. The heap it holds is large
// arrays, which leave no such garbage behind.
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { lintWhileTaking } from './support/memory.js';

const MIB = 1024 * 1024;
const own = Object.getOwnPropertyDescriptor(Worker.prototype, 'getHeapStatistics');

afterEach(() => {
  if (own !== undefined) Object.defineProperty(Worker.prototype, 'getHeapStatistics', own);
});

describe('runScripts memory, measured as on Node.js older than 22.16', () => {
  it('does not count the JavaScript heap and buffers the server thread holds against the lint', async () => {
    if (own !== undefined) delete (Worker.prototype as { getHeapStatistics?: unknown }).getHeapStatistics;
    const { answer, held } = await lintWhileTaking(() => [Array.from({ length: 25 }, () => new Array<number>(1_250_000).fill(1)), Buffer.alloc(64 * MIB, 1)] as const, 64 * MIB);
    expect(answer).toBe('PostgreSQL 0 (fake)');
    expect([held[0].length, held[1].byteLength]).toEqual([25, 64 * MIB]); // about 250 MB of arrays, and the buffer
  });
});
