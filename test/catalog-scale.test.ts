// The final catalog query (src/lint/catalog.ts, SPEC.md §3.4) grows with the schema, not with its
// square: in review round 4 a 1,000-table pg_dump ran out of time inside money-guard's own query. The
// database runs on the test's own thread: it is the only one in this file's process (test/support/sql.ts).
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { DETAIL_SQL } from '../src/lint/catalog.js';

/** Tables shaped like an app's: 15 columns each, a primary key, NOT NULLs, defaults, a foreign key and an index. */
function schema(tables: number): string {
  const out: string[] = [];
  for (let t = 1; t <= tables; t += 1) {
    const own = Array.from({ length: 11 }, (_, i) => `t${t}_f${i} ${['text not null', 'integer', 'timestamptz'][i % 3] ?? ''}`).join(', ');
    const parent = t > 1 ? ` references t${t - 1} (id)` : '';
    out.push(`create table t${t} (id bigserial primary key, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), ${own}, parent_id bigint${parent});`);
    out.push(`create index t${t}_f0_idx on t${t} (t${t}_f0);`);
  }
  return out.join('\n');
}

describe('DETAIL_SQL', () => {
  it('reads a 400-table schema in well under the time limit', async () => {
    const db = await PGlite.create();
    try {
      await db.exec(schema(400));
      const started = performance.now();
      const rows = (await db.query(DETAIL_SQL)).rows;
      const ms = performance.now() - started;
      expect(rows).toHaveLength(400 * 15);
      // About 0.3 s. Looked up column by column, as after review round 3, it took over 10 s.
      expect(ms).toBeLessThan(4000);
    } finally {
      await db.close();
    }
  });
});
