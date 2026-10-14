import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A schema lint starts a PostgreSQL in WebAssembly (about 1.5 s); give those tests room.
    testTimeout: 60_000,
  },
});
