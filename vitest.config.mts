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
    // 4.9 GB on a 12-core machine, and ran slower (review round 15).
    maxWorkers: 4,
    // A schema lint starts a PostgreSQL in WebAssembly (about 1.5 s); give those tests room.
    testTimeout: 60_000,
  },
});
