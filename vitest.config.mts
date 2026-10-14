import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Builds dist/ once: the stdio and README tests start the built server.
    globalSetup: ['test/support/build.ts'],
    // A schema lint starts a PostgreSQL in WebAssembly (about 1.5 s); give those tests room.
    testTimeout: 60_000,
  },
});
