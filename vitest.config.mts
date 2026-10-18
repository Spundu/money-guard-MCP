import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Builds dist/ once: the stdio and README tests start the built server.
    globalSetup: ['test/support/build.ts'],
    // Each test file in its own process: catalog-scale.test.ts runs PGlite on the test's own thread,
    // which is safe only while no other file's lints share the process (SPEC.md §3.4).
    pool: 'forks',
    // At most 4 at once: each lint's database can take 1 GiB, and the default (one per core) passed
    // 4.9 GB on a 12-core machine, and ran slower (review round 15). And no more than the CPUs: on a
    // 2-CPU CI runner, 4 files each starting databases made a lint take 8 s, not 1.5 s (2026-10-18).
    maxWorkers: Math.min(4, availableParallelism()),
    // A schema lint starts a PostgreSQL in WebAssembly (about 1.5 s here, 8 s on a busy CI runner), and some
    // tests run ten: the limit stops a hang, it is no measure of speed (CI, 2026-10-18: 60 s cut one off).
    testTimeout: 180_000,
    // afterEach waits for a cancelled lint's thread to end (test/support/lint.ts).
    hookTimeout: 60_000,
  },
});
